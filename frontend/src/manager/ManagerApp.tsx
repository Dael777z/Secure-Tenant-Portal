// The manager side: what property managers and on-site maintenance staff see
// after signing in. Same sign-in and session as the resident portal; the
// backend decides what each role may do (Scott's RBAC permissions), and this
// only hides what the role cannot use.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionUser } from "../api/auth";
import { managerApi, type StaffProfile } from "./api";
import { DialogHost } from "./dialogs";
import { FinancePage, PerformancePage, ProfitLossPage, RenewalsPage } from "./finance";
import { MessagesPage } from "./messages";
import { SetupPage } from "./onboarding";
import { DocumentsPage, PaymentRulesPage, PaymentsPage, RentChargesPage, SettingsPage, TenantPage, UnitPage } from "./ops";
import {
  DashboardPage,
  LeasePage,
  MaintenancePage,
  PropertiesPage,
  PropertyPage,
  RentRollPage,
  TenantsPage,
  UpdatesPage,
} from "./pages";
import { ManagerContext, initials, parseRoute, routeHash, useTableLabels, type Dialog, type ManagerContextValue, type Route } from "./ui";
import "./manager.css";

const ROLE_LABELS: Record<string, string> = {
  admin: "Property Manager",
  property_manager: "Property Manager",
  maintenance_staff: "Maintenance",
  platform_admin: "Administrator",
};

interface NavLink {
  label: string;
  route: Route;
  matches: Array<Route["name"]>;
  permission: string;
}

interface NavFolder {
  label: string;
  items: NavLink[];
}

// The sidebar: folders of pages (RentRedi's layout). A folder with one page is a
// plain link; a folder with several opens to show them, and the pages of the
// open folder are also the tabs across the top of each of its pages.
const NAV: NavFolder[] = [
  { label: "Dashboard", items: [{ label: "Dashboard", route: { name: "dashboard" }, matches: ["dashboard"], permission: "ledger:read:property" }] },
  { label: "Performance", items: [{ label: "Performance", route: { name: "performance" }, matches: ["performance"], permission: "ledger:read:property" }] },
  {
    label: "Properties & Units",
    items: [
      { label: "Units", route: { name: "rent-roll" }, matches: ["rent-roll", "unit", "lease"], permission: "ledger:read:property" },
      { label: "Properties", route: { name: "properties" }, matches: ["properties", "property", "setup"], permission: "ledger:read:property" },
      { label: "Documents", route: { name: "documents" }, matches: ["documents"], permission: "ledger:read:property" },
    ],
  },
  {
    label: "Payments",
    items: [
      { label: "Rent & Charges", route: { name: "charges", month: "" }, matches: ["charges"], permission: "ledger:read:property" },
      { label: "Payments & Returns", route: { name: "payments", period: "this-month" }, matches: ["payments"], permission: "ledger:read:property" },
      { label: "Payment Rules", route: { name: "payment-rules", tab: "late-fees" }, matches: ["payment-rules"], permission: "ledger:read:property" },
    ],
  },
  {
    label: "Accounting",
    items: [
      { label: "Finance", route: { name: "finance", period: "this-month" }, matches: ["finance"], permission: "ledger:read:property" },
      { label: "Profit & Loss", route: { name: "pnl", period: "ytd" }, matches: ["pnl"], permission: "ledger:read:property" },
    ],
  },
  { label: "Tenants", items: [{ label: "Tenants", route: { name: "tenants" }, matches: ["tenants", "tenant"], permission: "ledger:read:property" }] },
  { label: "Maintenance", items: [{ label: "Maintenance", route: { name: "maintenance" }, matches: ["maintenance"], permission: "maintenance:manage" }] },
  { label: "Leasing", items: [{ label: "Lease renewals", route: { name: "renewals", days: 90 }, matches: ["renewals"], permission: "ledger:read:property" }] },
  {
    label: "Communications",
    items: [
      { label: "Messages", route: { name: "messages" }, matches: ["messages"], permission: "messages:manage" },
      { label: "Updates", route: { name: "updates" }, matches: ["updates"], permission: "ledger:read:property" },
    ],
  },
  { label: "Settings", items: [{ label: "Settings", route: { name: "settings", tab: "account" }, matches: ["settings"], permission: "ledger:read:property" }] },
];

/** "Rent & Charges" opens on this month. */
const resolve = (route: Route): Route => (route.name === "charges" && !route.month ? { name: "charges", month: new Date().toISOString().slice(0, 7) } : route);

export function ManagerApp({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const can = useCallback((permission: string) => user.permissions.includes(permission), [user.permissions]);
  const home: Route = can("ledger:read:property") ? { name: "dashboard" } : { name: "maintenance" };
  const allowed = useCallback(
    (route: Route) => NAV.some((f) => f.items.some((n) => n.matches.includes(route.name) && can(n.permission))),
    [can],
  );

  const [route, setRoute] = useState<Route>(() => {
    const r = parseRoute(location.hash);
    return r && allowed(r) ? r : home;
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [unreadMessages, setUnreadMessages] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  useTableLabels(shellRef);

  useEffect(() => {
    managerApi.me().then(setProfile, () => setProfile(null));
  }, []);

  // The Messages badge: conversations waiting on the office, checked every 20 seconds.
  const canMessage = can("messages:manage");
  const refreshUnread = useCallback(() => {
    if (canMessage) managerApi.unreadMessages().then(setUnreadMessages, () => undefined);
  }, [canMessage]);
  useEffect(() => {
    refreshUnread();
    const timer = setInterval(() => document.visibilityState === "visible" && refreshUnread(), 20_000);
    return () => clearInterval(timer);
  }, [refreshUnread]);

  // Keep the route in the URL hash so Back, Forward and reload work.
  useEffect(() => {
    const onHash = () => {
      const r = parseRoute(location.hash);
      const next = r && allowed(r) ? r : home;
      if (location.hash !== routeHash(next)) history.replaceState(null, "", routeHash(next));
      setRoute(next);
      setMenuOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    if (location.hash !== routeHash(route)) history.replaceState(null, "", routeHash(route));
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const go = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (location.hash === hash) setRoute(next);
    else location.hash = hash;
    window.scrollTo(0, 0);
  }, []);

  const ctx: ManagerContextValue = useMemo(
    () => ({
      user,
      can,
      go,
      open: setDialog,
      version,
      changed: (message?: string) => {
        setVersion((v) => v + 1);
        if (message) setToast(message);
      },
    }),
    [user, can, go, version],
  );

  const name = profile?.name ?? user.email ?? "Staff";
  const nav = NAV.map((f) => ({ ...f, items: f.items.filter((n) => can(n.permission)) })).filter((f) => f.items.length > 0);
  const activeFolder = nav.find((f) => f.items.some((n) => n.matches.includes(route.name)));
  const canCreate = can("users:provision") || can("ledger:adjust") || can("maintenance:manage");
  const link = (n: NavLink, className: string, children: React.ReactNode) => {
    const active = n.matches.includes(route.name);
    const to = resolve(n.route);
    return (
      <a
        key={n.label}
        href={routeHash(to)}
        className={`${className}${active ? ` ${className}--active` : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          e.preventDefault();
          go(to);
          setMenuOpen(false);
        }}
      >
        {children}
      </a>
    );
  };

  return (
    <ManagerContext.Provider value={ctx}>
      <div className="mgr-shell" ref={shellRef}>
        <aside className={`mgr-sidebar${menuOpen ? " mgr-sidebar--open" : ""}`} aria-label="Manager navigation">
          <div className="mgr-brand">
            <span className="mgr-brand__mark" aria-hidden="true">SP</span>
            <span>
              <strong>Secure Tenant Portal</strong>
              <span className="mgr-brand__sub">{can("ledger:read:property") ? "Manager workspace" : "Maintenance workspace"}</span>
            </span>
          </div>
          {canCreate && (
            <button type="button" className="mgr-create-btn" onClick={() => setDialog({ kind: "create" })}>
              + Create new
            </button>
          )}
          <nav className="mgr-nav">
            {nav.map((f) => {
              const inside = f === activeFolder;
              if (f.items.length === 1) {
                const n = f.items[0]!;
                return link(
                  n,
                  "mgr-nav__item",
                  <>
                    {f.label}
                    {n.route.name === "messages" && unreadMessages > 0 && (
                      <span className="mgr-nav__badge" aria-label={`${unreadMessages} unread`}>
                        {unreadMessages}
                      </span>
                    )}
                  </>,
                );
              }
              const isOpen = openFolders[f.label] ?? inside;
              return (
                <div key={f.label} className={`mgr-nav__folder${inside ? " mgr-nav__folder--inside" : ""}`}>
                  <button
                    type="button"
                    className="mgr-nav__item mgr-nav__toggle"
                    aria-expanded={isOpen}
                    onClick={() => setOpenFolders({ ...openFolders, [f.label]: !isOpen })}
                  >
                    {f.label}
                    {f.items.some((n) => n.route.name === "messages") && unreadMessages > 0 && !isOpen && (
                      <span className="mgr-nav__badge" aria-label={`${unreadMessages} unread`}>
                        {unreadMessages}
                      </span>
                    )}
                    <span className="mgr-nav__chevron" aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
                  </button>
                  {isOpen && (
                    <div className="mgr-nav__sub">
                      {f.items.map((n) =>
                        link(
                          n,
                          "mgr-nav__subitem",
                          <>
                            {n.label}
                            {n.route.name === "messages" && unreadMessages > 0 && (
                              <span className="mgr-nav__badge" aria-label={`${unreadMessages} unread`}>
                                {unreadMessages}
                              </span>
                            )}
                          </>,
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="mgr-me">
            <span className="mgr-me__avatar" aria-hidden="true">{initials(name)}</span>
            <span className="mgr-me__text">
              <strong>{name}</strong>
              <span>{ROLE_LABELS[user.role] ?? user.role}</span>
            </span>
          </div>
          <button type="button" className="mgr-signout" onClick={onLogout}>
            Sign out
          </button>
        </aside>
        {menuOpen && <div className="mgr-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
        <div className="mgr-main">
          <div className="mgr-topbar">
            <button type="button" className="mgr-menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
              ☰ Menu
            </button>
            <span className="mgr-topbar__title">Secure Tenant Portal</span>
          </div>
          <main className="mgr-content" id="main">
            {activeFolder && activeFolder.items.length > 1 && (
              <nav className="mgr-section-tabs" aria-label={activeFolder.label}>
                <span className="mgr-section-tabs__folder">{activeFolder.label}</span>
                {activeFolder.items.map((n) => link(n, "mgr-section-tab", n.label))}
              </nav>
            )}
            {route.name === "dashboard" && <DashboardPage name={name} />}
            {route.name === "properties" && <PropertiesPage />}
            {route.name === "property" && <PropertyPage id={route.id} />}
            {route.name === "rent-roll" && <RentRollPage filter={route.filter} />}
            {route.name === "unit" && <UnitPage id={route.id} tab={route.tab} />}
            {route.name === "documents" && <DocumentsPage />}
            {route.name === "tenants" && <TenantsPage view={route.view} />}
            {route.name === "tenant" && <TenantPage id={route.id} tab={route.tab} />}
            {route.name === "lease" && <LeasePage id={route.id} />}
            {route.name === "charges" && <RentChargesPage month={route.month} />}
            {route.name === "payments" && <PaymentsPage period={route.period} view={route.view} />}
            {route.name === "payment-rules" && <PaymentRulesPage tab={route.tab} />}
            {route.name === "maintenance" && <MaintenancePage view={route.view} />}
            {route.name === "messages" && <MessagesPage tenantId={route.tenantId} onUnreadChange={refreshUnread} />}
            {route.name === "updates" && <UpdatesPage />}
            {route.name === "finance" && <FinancePage period={route.period} />}
            {route.name === "pnl" && <ProfitLossPage period={route.period} />}
            {route.name === "performance" && <PerformancePage />}
            {route.name === "renewals" && <RenewalsPage days={route.days} />}
            {route.name === "setup" && <SetupPage />}
            {route.name === "settings" && <SettingsPage tab={route.tab} />}
          </main>
        </div>
        {dialog && <DialogHost dialog={dialog} onClose={() => setDialog(null)} />}
        {toast && (
          <div className="mgr-toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </ManagerContext.Provider>
  );
}
