/**
 * The manager workspace's front screens, from the Figma prototype:
 *
 *   /manage             Desktop / Manager Dashboard  +  Mobile / Manager Home
 *   /manage/alerts      Mobile / Alerts & Approvals (works on desktop too)
 *   /manage/properties  the sidebar's "Properties"
 *   /manage/more        the mobile tab bar's "More"
 *
 * The dashboard renders both layouts and lets CSS pick one, so the same URL is
 * the desktop dashboard on a laptop and the mobile home on a phone, from one
 * request. The exception queue is still one click away ("Overdue Accounts",
 * "Needs Review"): the dashboard summarises it, it does not replace it.
 */

import { h, render } from "../core/dom.ts";
import { manager } from "../core/api.ts";
import { can, navigate, state, moreMenuItems, signOut, linkHandler } from "../core/app.ts";
import {
  addMonths,
  currentPeriod,
  greeting,
  parseTimestamp,
  percent,
  period as formatPeriod,
  periodRange,
  timeAgo,
  wholeMoney,
} from "../core/fmt.ts";
import {
  actionCard,
  activityItem,
  alertItem,
  kpi,
  kpiRow,
  progress,
  selectField,
  wsButton,
  wsHeader,
} from "../core/workspace.ts";
import { EXCEPTION_LABELS } from "/shared/api.js";
import { managerQuickActions, photoThumb } from "./manager-portfolio.ts";
import type { ActivityItem, DashboardResponse } from "/shared/api.js";

type Property = { id: string; name: string; city: string; state: string; unit_count: number; occupied: number };

function withParams(path: string, updates: Record<string, string | null>): string {
  const next = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

function periodChoices(): Array<{ value: string; label: string }> {
  const now = currentPeriod();
  return Array.from({ length: 12 }, (_, i) => {
    const key = addMonths(now, -i);
    return { value: key, label: periodRange(key) };
  });
}

function propertyChoices(properties: Property[]): Array<{ value: string; label: string }> {
  return [{ value: "", label: "All Properties" }, ...properties.map((p) => ({ value: p.id, label: p.name }))];
}

function activityHref(item: ActivityItem): string | null {
  if (item.workOrderId && can("workorder:read:property")) return `/manage/maintenance/${item.workOrderId}`;
  if (item.tenancyId && can("ledger:read:property")) return `/manage/tenancy/${item.tenancyId}`;
  return null;
}

/* ------------------------------------------------------------------ *
 * Dashboard / Manager Home
 * ------------------------------------------------------------------ */

export async function managerDashboard(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const period = params.get("period") ?? currentPeriod();
  const propertyId = params.get("propertyId") ?? "";

  const [data, props] = await Promise.all([
    manager.dashboard({ period, propertyId: propertyId || undefined }),
    manager.properties(),
  ]);

  const property = props.properties.find((p) => p.id === propertyId);
  const scopeLabel = property ? property.name : "All properties";
  const occupancy = data.portfolio.units > 0 ? data.portfolio.occupied / data.portfolio.units : 0;
  const month = formatPeriod(data.period).split(" ")[0];

  mount.classList.add("ws-main--tight");

  const propertySelect = (width: "wide" | "block") =>
    selectField({
      label: "Property",
      value: propertyId,
      choices: propertyChoices(props.properties),
      width,
      onChange: (value) => navigate(withParams("/manage", { propertyId: value || null })),
    });

  render(
    mount,
    desktopDashboard(data, { period, scopeLabel, occupancy }),
    mobileHome(data, { propertySelect: propertySelect("block"), occupancy, month }),
  );
}

function desktopDashboard(
  data: DashboardResponse,
  view: { period: string; scopeLabel: string; occupancy: number },
): HTMLElement {
  const { portfolio, rent, maintenance } = data;
  const periodSelect = selectField({
    label: "Reporting period",
    value: view.period,
    choices: periodChoices(),
    width: "wide",
    onChange: (value) => navigate(withParams("/manage", { period: value === currentPeriod() ? null : value })),
  });

  const fourth = maintenance
    ? kpi(
        "Open Maintenance",
        String(maintenance.open),
        `${maintenance.highPriority} high-priority request${maintenance.highPriority === 1 ? "" : "s"}`,
        "/manage/maintenance",
      )
    : kpi("Needs Review", String(rent.needsReview), "Failed, returned or disputed", "/manage/updates");

  return h(
    "div",
    { class: "ws-stack ws-only-desktop" },
    wsHeader("Dashboard", `Your portfolio at a glance. ${view.scopeLabel}.`, periodSelect, "ws-header__control--wide"),
    // Start the common jobs from here without hunting for the right screen.
    managerQuickActions(),
    kpiRow([
      kpi("Total Properties", String(portfolio.properties), "Across your portfolio", "/manage/properties"),
      kpi("Total Units", String(portfolio.units), "All residential units"),
      kpi("Occupied", String(portfolio.occupied), `${percent(view.occupancy)} occupancy rate`),
      kpi("Vacant", String(portfolio.vacant), `${percent(1 - view.occupancy)} available to lease`),
    ]),
    kpiRow([
      kpi(
        "Rent Collected",
        wholeMoney(rent.collectedCents),
        `${percent(rent.collectionRate)} of ${wholeMoney(rent.expectedCents)} expected`,
        "/manage/rent-roll",
      ),
      kpi("Outstanding", wholeMoney(rent.outstandingCents), "Remaining this month", "/manage/rent-roll?status=unpaid"),
      kpi("Overdue Accounts", String(rent.overdueAccounts), "See updates on payments", "/manage/updates"),
      fourth,
    ]),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "recent-activity" },
      h("h2", { class: "ws-h3", id: "recent-activity" }, "Recent Activity"),
      data.activity.length === 0
        ? h("p", { class: "ws-empty" }, "Nothing has happened yet.")
        : h(
            "div",
            { class: "ws-activity" },
            ...data.activity.map((item) => activityItem(item.title, item.detail, timeAgo(item.at), activityHref(item))),
          ),
    ),
  );
}

function mobileHome(
  data: DashboardResponse,
  view: { propertySelect: HTMLElement; occupancy: number; month: string },
): HTMLElement {
  const { portfolio, rent, maintenance } = data;
  const user = state.user!;

  // The prototype's four quick actions. "Approve Payments" has no approval step
  // in this system, so it is the exception queue — the accounts awaiting a decision.
  const actions: HTMLElement[] = [
    actionCard("Review Updates", `${rent.needsReview} need a decision`, "/manage/updates"),
    maintenance
      ? actionCard("Maintenance Queue", `${maintenance.open} open`, "/manage/maintenance")
      : actionCard("Overdue Accounts", `${rent.overdueAccounts} accounts`, "/manage/updates"),
    actionCard("View Reports", `${view.month} overview`, "/manage/reports"),
    data.unreadMessages !== null
      ? actionCard("Messages", `${data.unreadMessages} unread`, "/manage/messages")
      : actionCard("Alerts", "Payments to review", "/manage/alerts"),
  ];

  return h(
    "div",
    { class: "ws-stack ws-only-mobile" },
    h(
      "div",
      { class: "ws-greeting" },
      h("span", { class: "ws-greeting__hello" }, greeting()),
      h("h1", { class: "ws-h1" }, user.displayName),
      h("span", { class: "ws-greeting__role" }, state.roleLabel || user.role),
    ),
    view.propertySelect,
    kpiRow(
      [
        kpi("Total Units", String(portfolio.units), "Portfolio"),
        kpi("Occupied", String(portfolio.occupied), percent(view.occupancy)),
        kpi("Vacant", String(portfolio.vacant), percent(1 - view.occupancy)),
      ],
      true,
    ),
    h(
      "a",
      { class: "ws-collected", href: "/manage/rent-roll", onClick: linkHandler("/manage/rent-roll"), style: { textDecoration: "none", color: "inherit" } },
      h("span", { class: "ws-kpi__title" }, `Rent Collected (${view.month.slice(0, 3)})`),
      h("span", { class: "ws-kpi__value" }, wholeMoney(rent.collectedCents)),
      progress(rent.collectionRate, "Share of expected rent collected"),
      h("span", { class: "ws-kpi__detail", style: { color: "var(--color-secondary)" } }, `${percent(rent.collectionRate)} of ${wholeMoney(rent.expectedCents)}`),
    ),
    h(
      "section",
      { class: "ws-quick", "aria-labelledby": "quick-actions" },
      h("h2", { class: "ws-h3", id: "quick-actions" }, "Quick Actions"),
      h("div", { class: "ws-quick__grid" }, ...actions),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Alerts & Approvals
 * ------------------------------------------------------------------ */

interface Alert {
  group: "payments" | "maintenance";
  title: string;
  detail: string;
  at: string;
  href: string | null;
}

export async function managerAlerts(mount: HTMLElement): Promise<void> {
  const filter = new URLSearchParams(location.search).get("filter") ?? "all";
  const readsMoney = can("rentroll:read");
  const readsMaintenance = can("workorder:read:property");

  const [exceptions, workOrders] = await Promise.all([
    readsMoney ? manager.exceptions() : Promise.resolve(null),
    readsMaintenance ? manager.workOrders({ status: "open" }) : Promise.resolve(null),
  ]);

  const alerts: Alert[] = [];

  for (const row of exceptions?.rows ?? []) {
    alerts.push({
      group: "payments",
      title: EXCEPTION_LABELS[row.kind],
      detail: `Unit ${row.unitLabel} / ${row.residentName}`,
      at: row.occurredAt,
      href: `/manage/tenancy/${row.tenancyId}`,
    });
  }

  for (const order of workOrders?.workOrders ?? []) {
    const ageHours = (Date.now() - parseTimestamp(order.submittedAt)) / 3_600_000;
    const target = workOrders!.targetHours[order.priority] ?? 120;
    const overdue = ageHours > target;
    if (order.priority !== "emergency" && !overdue && order.status !== "submitted") continue;
    alerts.push({
      group: "maintenance",
      title:
        order.priority === "emergency"
          ? "High priority maintenance"
          : overdue
            ? "Maintenance past its response target"
            : "New maintenance request",
      detail: `Unit ${order.unitLabel} / ${order.title}`,
      at: order.submittedAt,
      href: `/manage/maintenance/${order.id}`,
    });
  }

  alerts.sort((a, b) => b.at.localeCompare(a.at));
  const shown = alerts.filter((alert) => filter === "all" || alert.group === filter);

  const segments: Array<{ value: string; label: string }> = [{ value: "all", label: "All" }];
  if (readsMoney) segments.push({ value: "payments", label: "Payments" });
  if (readsMaintenance) segments.push({ value: "maintenance", label: "Maintenance" });

  render(
    mount,
    h(
      "div",
      { class: "ws-stack", style: { maxWidth: "720px" } },
      h("h1", { class: "ws-h2" }, "Alerts & Approvals"),
      h("p", { class: "ws-sub" }, "Stay on top of what needs you."),
      h(
        "div",
        { class: "ws-segments", role: "group", "aria-label": "Filter alerts" },
        ...segments.map((segment) =>
          wsButton(segment.label, {
            style: filter === segment.value ? "primary" : "secondary",
            onClick: () => navigate(withParams("/manage/alerts", { filter: segment.value === "all" ? null : segment.value })),
          }),
        ),
      ),
      shown.length === 0
        ? h("p", { class: "ws-empty" }, "Nothing needs you right now.")
        : h("div", { class: "ws-alerts" }, ...shown.map((a) => alertItem(a.title, a.detail, timeAgo(a.at), a.href))),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Properties
 * ------------------------------------------------------------------ */

export async function managerProperties(mount: HTMLElement): Promise<void> {
  const data = await manager.properties();
  const units = data.properties.reduce((sum, p) => sum + p.unit_count, 0);
  const occupied = data.properties.reduce((sum, p) => sum + p.occupied, 0);

  render(
    mount,
    wsHeader(
      "Properties",
      "Every property in the portfolio, with occupancy. Open one to see its units and start a lease.",
      can("portfolio:manage")
        ? h(
            "div",
            { class: "ws-toolbar" },
            can("data:import") ? wsButton("Import records", { style: "secondary", href: "/manage/import" }) : null,
            wsButton("+ Add Property", {
              onClick: async () => (await import("./manager-portfolio.ts")).openPropertyDialog(),
            }),
          )
        : undefined,
    ),
    kpiRow([
      kpi("Total Properties", String(data.properties.length), "Across your portfolio"),
      kpi("Total Units", String(units), "All residential units"),
      kpi("Occupied", String(occupied), `${percent(units ? occupied / units : 0)} occupancy rate`),
      kpi("Vacant", String(units - occupied), `${percent(units ? 1 - occupied / units : 0)} available to lease`),
    ]),
    h(
      "section",
      { class: "ws-panel" },
      h(
        "div",
        { class: "ws-table-wrap" },
        h(
          "table",
          { class: "ws-table ws-table--plain" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Photo")),
              h("th", { scope: "col" }, "Property"),
              h("th", { scope: "col" }, "Location"),
              h("th", { scope: "col" }, "Units"),
              h("th", { scope: "col" }, "Occupied"),
              h("th", { scope: "col" }, "Vacant"),
              h("th", { scope: "col" }, "Occupancy"),
            ),
          ),
          h(
            "tbody",
            {},
            ...data.properties.map((p) => {
              const href = `/manage/properties/${p.id}`;
              return h(
                "tr",
                {
                  class: "is-clickable",
                  tabindex: "0",
                  onClick: () => navigate(href),
                  onKeydown: (event: KeyboardEvent) => {
                    if (event.key === "Enter") navigate(href);
                  },
                },
                h("td", { class: "photo-cell" }, photoThumb(p.cover_photo_id, p.name)),
                h("td", {}, p.name),
                h("td", {}, `${p.city}, ${p.state}`),
                h("td", {}, String(p.unit_count)),
                h("td", {}, String(p.occupied)),
                h("td", {}, String(p.unit_count - p.occupied)),
                h("td", {}, percent(p.unit_count ? p.occupied / p.unit_count : 0)),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * More (mobile)
 * ------------------------------------------------------------------ */

export async function managerMore(mount: HTMLElement): Promise<void> {
  const user = state.user!;
  render(
    mount,
    h(
      "div",
      { class: "ws-stack", style: { maxWidth: "720px" } },
      h(
        "div",
        { class: "ws-greeting" },
        h("h1", { class: "ws-h2" }, user.displayName),
        h("span", { class: "ws-greeting__role" }, `${state.roleLabel || user.role} · ${user.email}`),
      ),
      h(
        "div",
        { class: "ws-alerts" },
        ...moreMenuItems().map((item) => alertItem(item.label, "", "Open", item.path)),
      ),
      wsButton("Sign out", { style: "secondary", block: true, onClick: () => void signOut() }),
    ),
  );
}
