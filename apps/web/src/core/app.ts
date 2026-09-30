/**
 * Application state, routing, and the shared chrome.
 *
 * Routing is hash-free and history-based, with the server serving the shell for
 * any unmatched path. Views are functions that receive a mount point and render
 * into it; there is no virtual DOM and no reconciliation, because at this size
 * the whole-subtree replace is both simpler to reason about and fast enough.
 */

import { h, render, icon, ICONS, type Child } from "./dom.ts";
import { auth, ApiError, messages as messagesApi, setCsrfToken, type MeResponse } from "./api.ts";
import type { SessionUser } from "/shared/api.js";
import type { Capability } from "/shared/roles.js";

export interface AppState {
  user: SessionUser | null;
  capabilities: Capability[];
  roleLabel: string;
  roleDescription: string;
  ready: boolean;
}

export const state: AppState = {
  user: null,
  capabilities: [],
  roleLabel: "",
  roleDescription: "",
  ready: false,
};

export type View = (mount: HTMLElement, params: Record<string, string>) => void | Promise<void>;

interface Route {
  path: string;
  segments: string[];
  view: () => Promise<View>;
  /** Which roles may reach this route; empty means anyone signed in. */
  roles?: string[];
}

const routes: Route[] = [];

export function route(path: string, view: () => Promise<View>, roles?: string[]): void {
  routes.push({ path, segments: path.split("/").filter(Boolean), view, roles });
}

function match(pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const candidate of routes) {
    if (candidate.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < candidate.segments.length; i += 1) {
      const segment = candidate.segments[i];
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(parts[i]);
      else if (segment !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: candidate, params };
  }
  return null;
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  void draw();
}

export function can(capability: Capability): boolean {
  return state.capabilities.includes(capability);
}

export function isManagerSide(): boolean {
  return state.user?.role === "manager" || state.user?.role === "staff" || state.user?.role === "owner";
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export function toast(message: string, tone: "info" | "good" | "bad" = "info"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const element = h("div", { class: ["toast", tone !== "info" && `toast--${tone}`], role: "status" }, message);
  host.appendChild(element);
  setTimeout(() => {
    element.style.opacity = "0";
    element.style.transition = "opacity 200ms";
    setTimeout(() => element.remove(), 220);
  }, tone === "bad" ? 7000 : 4000);
}

/**
 * Turn a thrown error into something a person can act on.
 *
 * A 401 means the session ended while they were reading, which happens and is
 * not an error to apologize for — it just means signing in again. Everything
 * else shows the server's own message, which is written for the reader.
 */
export function reportError(error: unknown): void {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      state.user = null;
      setCsrfToken(null);
      toast("Your session ended. Please sign in again.", "info");
      navigate("/sign-in", { replace: true });
      return;
    }
    toast(error.message, "bad");
    return;
  }
  // A request cut off because the page is going away is not worth a word.
  if (leaving) return;
  // fetch() rejects with a TypeError when the network, not the server, failed.
  // The request may or may not have arrived, so don't promise nothing changed.
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    toast("Couldn't reach the portal. Check your connection, then reload to see where things stand.", "bad");
    return;
  }
  console.error(error);
  toast("Something went wrong. Nothing was changed.", "bad");
}

let leaving = false;
addEventListener("pagehide", () => (leaving = true));
addEventListener("pageshow", () => (leaving = false));

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

interface NavItem {
  path: string;
  label: string;
  iconPath: string;
}

const TENANT_NAV: NavItem[] = [
  { path: "/", label: "Overview", iconPath: ICONS.home },
  { path: "/ledger", label: "Ledger", iconPath: ICONS.ledger },
  { path: "/pay", label: "Pay rent", iconPath: ICONS.card },
  { path: "/maintenance", label: "Maintenance", iconPath: ICONS.wrench },
  { path: "/messages", label: "Messages", iconPath: ICONS.users },
  { path: "/documents", label: "Documents", iconPath: ICONS.ledger },
  { path: "/notices", label: "Notices", iconPath: ICONS.bell },
];

/**
 * The manager workspace navigation, in the Figma prototype's sidebar order
 * (Dashboard, Properties, Units, Tenants, Rent Roll, Maintenance, Reports,
 * Messages, Settings), plus Updates (formerly "Exceptions") — the queue of accounts that need a
 * decision, which is this project's core screen and has no Figma frame yet.
 * Charges live under Reports; Access and Privacy under Settings.
 */
// FRIDAY TEST COPY: the progress demo shows two tabs, Dashboard and
// Properties. Every other page still exists (the dashboard's add buttons and
// links open them); it is only left out of the sidebar. The full list is in the
// main project, apps/web/src/core/app.ts.
const MANAGER_NAV: NavItem[] = [
  { path: "/manage", label: "Dashboard", iconPath: ICONS.home },
  { path: "/manage/properties", label: "Properties", iconPath: ICONS.home },
];

const STAFF_NAV: NavItem[] = [
  { path: "/manage/maintenance", label: "Maintenance", iconPath: ICONS.wrench },
  { path: "/manage/messages", label: "Messages", iconPath: ICONS.users },
  { path: "/manage/settings", label: "Settings", iconPath: ICONS.shield },
];

/** Owners read the numbers and change nothing; resident correspondence is not theirs. */
const OWNER_NAV: NavItem[] = MANAGER_NAV; // FRIDAY TEST COPY

/**
 * Where each role lands.
 *
 * On-site staff go to maintenance, because that is the whole of what they can
 * reach — the financial screens are not merely hidden from them, the database
 * returns them no rows. Sending them to a manager dashboard they cannot read
 * would be a redirect loop wearing a nav bar.
 */
function homeFor(role: string): string {
  switch (role) {
    case "tenant":
      return "/";
    case "staff":
      return "/manage/maintenance";
    default:
      return "/manage";
  }
}

function navFor(role: string): NavItem[] {
  if (role === "tenant") return TENANT_NAV;
  if (role === "staff") return STAFF_NAV;
  if (role === "owner") return OWNER_NAV;
  return MANAGER_NAV;
}

function isActive(itemPath: string, current: string): boolean {
  if (itemPath === "/" || itemPath === "/manage") return current === itemPath;
  return current === itemPath || current.startsWith(`${itemPath}/`);
}

function header(): HTMLElement {
  const user = state.user!;
  const items = navFor(user.role);
  const current = location.pathname;

  return h(
    "header",
    { class: "site-header" },
    h(
      "div",
      { class: "container container--wide site-header__inner" },
      h(
        "a",
        { class: "brand", href: "/", onClick: linkHandler("/") },
        h("span", { class: "brand__mark", "aria-hidden": "true" }, "◧"),
        h(
          "span",
          { class: "brand__text" },
          h("span", { class: "brand__name" }, user.propertyName ?? user.organizationName),
          user.unitLabel ? h("span", { class: "brand__unit" }, `Unit ${user.unitLabel}`) : null,
        ),
      ),

      h(
        "nav",
        { class: "site-nav", "aria-label": "Main" },
        ...items.map((item) => {
          const active = isActive(item.path, current);
          return h(
            "a",
            {
              class: ["site-nav__item", active && "is-active"],
              href: item.path,
              "aria-current": active ? "page" : null,
              onClick: linkHandler(item.path),
            },
            icon(item.iconPath, 17),
            h("span", {}, item.label),
          );
        }),
      ),

      h(
        "div",
        { class: "site-header__user" },
        h(
          "div",
          { class: "site-header__identity" },
          h("span", { class: "site-header__name" }, user.displayName),
          h("span", { class: "site-header__role" }, state.roleLabel || user.role),
        ),
        h(
          "button",
          {
            class: "btn btn--quiet",
            type: "button",
            title: "Sign out",
            onClick: async () => {
              try {
                await auth.logout();
              } finally {
                state.user = null;
                navigate("/sign-in", { replace: true });
              }
            },
          },
          icon(ICONS.logout, 17),
          h("span", { class: "visually-hidden" }, "Sign out"),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Manager workspace chrome (Figma: Sidebar, Mobile Navigation)
 * ------------------------------------------------------------------ */

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

async function signOut(): Promise<void> {
  try {
    await auth.logout();
  } finally {
    state.user = null;
    navigate("/sign-in", { replace: true });
  }
}

/**
 * Unread conversations, for the Messages badge. Refreshed at most every 30
 * seconds as the person moves between screens; never blocks a page drawing.
 */
let unreadMessages = 0;
let unreadCheckedAt = 0;

export function refreshUnread(force = false): void {
  const role = state.user?.role;
  if (role !== "manager" && role !== "staff" && role !== "tenant") return;
  if (!force && Date.now() - unreadCheckedAt < 30_000) {
    paintUnread();
    return;
  }
  unreadCheckedAt = Date.now();
  const side = role === "tenant" ? "tenant" : "manager";
  void messagesApi
    .list(side)
    .then((data) => {
      unreadMessages = data.threads.filter((t) => t.unreadCount > 0).length;
      paintUnread();
    })
    .catch(() => {});
}

function paintUnread(): void {
  const href = state.user?.role === "tenant" ? "/messages" : "/manage/messages";
  const link = document.querySelector<HTMLAnchorElement>(`.ws-nav__item[href="${href}"], .site-nav__item[href="${href}"]`);
  if (!link) return;
  link.querySelector(".ws-nav__badge")?.remove();
  if (unreadMessages > 0) {
    link.appendChild(h("span", { class: "ws-nav__badge", "aria-label": `${unreadMessages} unread` }, String(unreadMessages)));
  }
}

function workspaceSidebar(): HTMLElement {
  const user = state.user!;
  const current = location.pathname;
  return h(
    "aside",
    { class: "ws-sidebar", "aria-label": "Workspace" },
    h("span", { class: "ws-sidebar__eyebrow" }, "Summit"),
    h(
      "span",
      { class: "ws-sidebar__title" },
      user.role === "staff" ? "Staff workspace" : user.role === "owner" ? "Owner workspace" : "Manager workspace",
    ),
    h("div", { class: "ws-sidebar__brand-space", "aria-hidden": "true" }),
    h(
      "nav",
      { class: "ws-nav", "aria-label": "Main" },
      ...navFor(user.role).map((item) => {
        const active = isActive(item.path, current);
        return h(
          "a",
          {
            class: ["ws-nav__item", active && "is-active"],
            href: item.path,
            "aria-current": active ? "page" : null,
            onClick: linkHandler(item.path),
          },
          item.label,
        );
      }),
    ),
    h("div", { class: "ws-sidebar__flex" }),
    h(
      "div",
      { class: "ws-user" },
      h(
        "div",
        {},
        h("span", { class: "ws-user__name" }, `${initials(user.displayName)}  ${user.displayName}`),
        h("span", { class: "ws-user__role" }, state.roleLabel || user.role),
      ),
      h(
        "button",
        { class: "ws-user__signout", type: "button", title: "Sign out", onClick: () => void signOut() },
        icon(ICONS.logout, 16),
        h("span", { class: "visually-hidden" }, "Sign out"),
      ),
    ),
  );
}

interface TabItem {
  path: string;
  label: string;
  icon: string;
  /** Paths that also light this tab. */
  also?: string[];
}

/**
 * The prototype's five mobile tabs. Home is the dashboard, Units the rent roll,
 * Tasks the maintenance queue, Alerts the combined alert feed, More everything
 * else. Icons are the prototype's own SVG exports (apps/web/assets/icons).
 */
function tabsFor(role: string): TabItem[] {
  const more: TabItem = {
    path: "/manage/more",
    label: "More",
    icon: "more",
    also: ["/manage/properties", "/manage/import", "/manage/charges", "/manage/access", "/manage/updates", "/manage/exceptions", "/manage/reports", "/manage/messages", "/manage/settings", "/privacy"],
  };
  if (role === "staff") {
    return [{ path: "/manage/maintenance", label: "Tasks", icon: "tasks" }, more];
  }
  // FRIDAY TEST COPY: phone tabs match the two sidebar tabs; More keeps sign out.
  return [
    { path: "/manage", label: "Home", icon: "home" },
    { path: "/manage/properties", label: "Properties", icon: "units", also: ["/manage/tenancy"] },
    { ...more, also: [] },
  ];
}

/** Icons with a distinct active export in the prototype. */
const ACTIVE_ICONS = new Set(["home", "tasks", "alerts"]);

function workspaceTabbar(): HTMLElement {
  const current = location.pathname;
  return h(
    "nav",
    { class: "ws-tabbar", "aria-label": "Main" },
    ...tabsFor(state.user!.role).map((tab) => {
      const active = isActive(tab.path, current) || (tab.also ?? []).some((path) => isActive(path, current));
      const file = active && ACTIVE_ICONS.has(tab.icon) ? `${tab.icon}-active` : tab.icon;
      return h(
        "a",
        {
          class: ["ws-tab", active && "is-active"],
          href: tab.path,
          "aria-current": active ? "page" : null,
          onClick: linkHandler(tab.path),
        },
        h("img", { src: `/app/assets/icons/${file}.svg`, alt: "", width: "24", height: "24" }),
        h("span", {}, tab.label),
      );
    }),
  );
}

/** Mobile "More": every destination that is not a tab, and sign out. */
export function moreMenuItems(): Array<{ path: string; label: string }> {
  const tabPaths = new Set(tabsFor(state.user!.role).map((tab) => tab.path));
  return navFor(state.user!.role).filter((item) => !tabPaths.has(item.path));
}

export { signOut };

export function linkHandler(path: string) {
  return (event: MouseEvent) => {
    // Let modified clicks open a new tab, as any link should.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };
}

export function link(path: string, ...children: Child[]): HTMLAnchorElement {
  return h("a", { href: path, onClick: linkHandler(path) }, ...children);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

let drawToken = 0;

export async function draw(): Promise<void> {
  const root = document.getElementById("root")!;
  const token = ++drawToken;

  if (!state.ready) {
    render(root, h("div", { class: "boot" }, "Loading…"));
    return;
  }

  const path = location.pathname;

  if (!state.user) {
    document.body.className = "theme-neutral";
    const views = await import("../views/sign-in.ts");
    if (token !== drawToken) return;
    render(root, h("main", { id: "main" }));
    // The only pages open without signing in: sign-in itself, and the
    // forgotten-password pages (020).
    const view =
      path === "/forgot-password" ? views.forgotPassword : path === "/reset-password" ? views.resetPassword : views.signIn;
    await view(root.querySelector("main")!);
    return;
  }

  if (state.user.mustChangePassword && path !== "/change-password") {
    navigate("/change-password", { replace: true });
    return;
  }

  document.body.className = isManagerSide() ? "theme-manager" : "theme-tenant";

  const found = match(path);
  const home = homeFor(state.user.role);

  // Send each role to the home it actually has, rather than to a 404 that tells
  // them nothing — but never navigate to the path we are already on, which
  // would spin forever for a role whose home is itself unreachable.
  if (!found && path !== home) {
    navigate(home, { replace: true });
    return;
  }

  if (found?.route.roles && !found.route.roles.includes(state.user.role)) {
    if (path !== home) {
      navigate(home, { replace: true });
      return;
    }
    // The home route itself refuses this role. That is a bug in the route
    // table, and saying so beats an empty screen or a redirect loop.
    render(
      root,
      header(),
      h(
        "main",
        { id: "main" },
        h(
          "div",
          { class: "container" },
          h(
            "div",
            { class: "notice notice--warn" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, "There is nothing here for this account."),
              h("span", {}, "Your role does not have access to this page. Contact the office if you expected to."),
            ),
          ),
        ),
      ),
    );
    return;
  }

  let main: HTMLElement;
  if (isManagerSide()) {
    main = h("main", { id: "main", class: "ws-main" });
    render(root, h("div", { class: "ws" }, workspaceSidebar(), main, workspaceTabbar()));
    refreshUnread();
  } else {
    main = h("main", { id: "main" });
    render(root, header(), main);
    refreshUnread();
  }

  if (!found) {
    render(
      main,
      h(
        "div",
        { class: "container" },
        h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That page does not exist.")),
      ),
    );
    return;
  }

  render(main, h("div", { class: "boot" }, "Loading…"));

  try {
    const view = await found.route.view();
    if (token !== drawToken) return;
    await view(main, found.params);
  } catch (error) {
    if (token !== drawToken) return;
    reportError(error);
    render(
      main,
      h(
        "div",
        { class: "container" },
        h(
          "div",
          { class: "notice notice--bad" },
          h(
            "div",
            { class: "notice__body" },
            h("span", { class: "notice__title" }, "This page could not load."),
            h("span", {}, error instanceof ApiError ? error.message : "Please try again."),
          ),
        ),
      ),
    );
  }
}

let listening = false;

export async function start(): Promise<void> {
  if (!listening) {
    window.addEventListener("popstate", () => void draw());
    listening = true;
  }

  try {
    const me: MeResponse = await auth.me();
    state.user = me.user;
    state.capabilities = me.capabilities ?? [];
    state.roleLabel = me.roleLabel ?? "";
    state.roleDescription = me.roleDescription ?? "";
    setCsrfToken(me.csrfToken);
  } catch (error) {
    // Only "not signed in" means show the sign-in form. A busy server (429), a
    // restart (5xx) or a dropped connection is not a sign-out, and sending a
    // signed-in person to a sign-in form that will also fail is how they end up
    // locked out by the rate limiter.
    if (!(error instanceof ApiError) || error.status !== 401) {
      showUnreachable(error);
      return;
    }
    state.user = null;
  }

  state.ready = true;
  await draw();
}

function showUnreachable(error: unknown): void {
  const root = document.getElementById("root")!;
  const busy = error instanceof ApiError && error.status === 429;
  document.body.className = "theme-neutral";
  render(
    root,
    h(
      "main",
      { id: "main" },
      h(
        "div",
        { class: "container container--narrow" },
        h(
          "div",
          { class: "notice notice--warn", role: "alert" },
          h(
            "div",
            { class: "notice__body" },
            h("span", { class: "notice__title" }, busy ? "The portal is busy right now." : "The portal could not be reached."),
            h("span", {}, busy ? "Too many requests arrived at once. Wait a few seconds and try again." : "Check your connection and try again. Nothing was changed."),
            h("button", { class: "btn btn--primary", type: "button", style: { marginTop: "0.75rem", alignSelf: "flex-start" }, onClick: () => void start() }, "Try again"),
          ),
        ),
      ),
    ),
  );
}

export async function refreshSession(): Promise<void> {
  const me = await auth.me();
  state.user = me.user;
  state.capabilities = me.capabilities ?? [];
  state.roleLabel = me.roleLabel ?? "";
  state.roleDescription = me.roleDescription ?? "";
  setCsrfToken(me.csrfToken);
}
