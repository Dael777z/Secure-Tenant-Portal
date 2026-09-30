/**
 * The prototype sidebar's Units, Tenants, Reports and Settings screens.
 *
 *   /manage/units     every unit, occupied or vacant, with its lease and balance
 *   /manage/tenants   the resident directory, with contact details and autopay
 *   /manage/reports   period exports (accountant, owner, legal) and the audit log
 *   /manage/settings  late-fee policy per property, account, access, privacy
 */

import { h, render } from "../core/dom.ts";
import { manager, ApiError } from "../core/api.ts";
import { can, linkHandler, navigate, state, toast } from "../core/app.ts";
import { addMonths, compactMoney, currentPeriod, date, dateTime, parseAmount, percent, period as formatPeriod, timeAgo, titleCase } from "../core/fmt.ts";
import { kpi, kpiRow, pager, pill, searchField, selectField, wsButton, wsHeader } from "../core/workspace.ts";
import type { TenantRow, UnitRow } from "/shared/api.js";
import { issueNewPassword, openAdjustDialog, openEditResidentDialog, rowMenu, screeningSection } from "./manager-portfolio.ts";
import { openNewThreadDialog } from "./messages.ts";

const PAGE_SIZE = 25;

function propertyFilter(properties: Array<{ id: string; name: string }>, value: string, path: string): HTMLElement {
  return selectField({
    label: "Property",
    value,
    choices: [{ value: "", label: "All Properties" }, ...properties.map((p) => ({ value: p.id, label: p.name }))],
    onChange: (next) => {
      const params = new URLSearchParams(location.search);
      next ? params.set("propertyId", next) : params.delete("propertyId");
      const qs = params.toString();
      navigate(qs ? `${path}?${qs}` : path);
    },
  });
}

function clickableRow(href: string | null, label: string, ...cells: HTMLElement[]): HTMLElement {
  if (!href) return h("tr", {}, ...cells);
  return h(
    "tr",
    {
      class: "is-clickable",
      tabindex: "0",
      "aria-label": label,
      onClick: () => navigate(href),
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") navigate(href);
      },
    },
    ...cells,
  );
}

/* ------------------------------------------------------------------ *
 * Units
 * ------------------------------------------------------------------ */

export async function managerUnits(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const propertyId = params.get("propertyId") ?? "";
  let occupancy = params.get("occupancy") ?? "all";
  let search = params.get("search") ?? "";
  let page = 0;

  const [data, props] = await Promise.all([manager.units({ propertyId: propertyId || undefined }), manager.properties()]);
  const units = data.units;
  const occupied = units.filter((u) => u.occupied).length;
  const vacant = units.length - occupied;
  const vacantRent = units.filter((u) => !u.occupied).reduce((sum, u) => sum + u.marketRentCents, 0);

  const host = h("div", { class: "ws-panel ws-panel--rows", "aria-live": "polite" });

  const setUrl = () => {
    const next = new URLSearchParams(location.search);
    occupancy === "all" ? next.delete("occupancy") : next.set("occupancy", occupancy);
    search ? next.set("search", search) : next.delete("search");
    const qs = next.toString();
    history.replaceState({}, "", qs ? `/manage/units?${qs}` : "/manage/units");
  };

  const draw = () => {
    const needle = search.toLowerCase();
    const rows = units.filter(
      (u) =>
        (occupancy === "all" || (occupancy === "occupied") === u.occupied) &&
        (!needle || u.label.toLowerCase().includes(needle) || (u.residentName ?? "").toLowerCase().includes(needle)),
    );
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    render(
      host,
      h(
        "div",
        { class: "ws-table-wrap" },
        h(
          "table",
          { class: "ws-table ws-table--units" },
          h("caption", { class: "visually-hidden" }, "Units"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col", class: "ws-col-68" }, "Unit"),
              h("th", { scope: "col" }, "Property"),
              h("th", { scope: "col" }, "Resident"),
              h("th", { scope: "col", class: "ws-col-130" }, "Market Rent"),
              h("th", { scope: "col", class: "ws-col-130" }, "Balance"),
              h("th", { scope: "col", class: "ws-col-160" }, "Lease"),
              h("th", { scope: "col" }, "Status"),
            ),
          ),
          h("tbody", {}, ...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(unitRow)),
        ),
      ),
      rows.length === 0 ? h("p", { class: "ws-empty" }, "No units match that filter.") : null,
      pager({ page, pageSize: PAGE_SIZE, total: rows.length, noun: "units", onPage: (n) => { page = n; draw(); } }),
    );
  };

  render(
    mount,
    wsHeader(
      "Units",
      "Every unit, occupied or vacant, with its lease and balance. Open a vacant unit to start a lease.",
      can("portfolio:manage")
        ? wsButton("+ Add Unit", {
            onClick: async () =>
              (await import("./manager-portfolio.ts")).openUnitDialog({ propertyId: propertyId || undefined }),
          })
        : undefined,
    ),
    kpiRow([
      kpi("Total Units", String(units.length), propertyId ? "At this property" : "All residential units"),
      kpi("Occupied", String(occupied), `${percent(units.length ? occupied / units.length : 0)} occupancy rate`),
      kpi("Vacant", String(vacant), `${percent(units.length ? vacant / units.length : 0)} available to lease`),
      kpi("Vacant Rent", compactMoney(vacantRent), "Monthly market rent not earning"),
    ]),
    h(
      "div",
      { class: "ws-filters", role: "search" },
      propertyFilter(props.properties, propertyId, "/manage/units"),
      selectField({
        label: "Occupancy",
        value: occupancy,
        choices: [
          { value: "all", label: "All Units" },
          { value: "occupied", label: "Occupied" },
          { value: "vacant", label: "Vacant" },
        ],
        onChange: (v) => { occupancy = v; page = 0; setUrl(); draw(); },
      }),
      searchField({ label: "Search units", placeholder: "Search unit or resident", value: search, onSearch: (v) => { search = v; page = 0; setUrl(); draw(); } }),
    ),
    host,
  );
  draw();
}

function unitRow(unit: UnitRow): HTMLElement {
  // A vacant unit opens its property, where the lease is started.
  const href = unit.tenancyId ? `/manage/tenancy/${unit.tenancyId}` : `/manage/properties/${unit.propertyId}`;
  return clickableRow(
    href,
    `Unit ${unit.label}, ${unit.occupied ? unit.residentName : "vacant"}`,
    h("td", {}, unit.label),
    h("td", {}, unit.propertyName, unit.bedrooms !== null ? h("span", { class: "ws-cell-meta" }, `${unit.bedrooms} bed`) : null),
    h("td", {}, unit.residentName ?? "—", unit.openWorkOrders ? h("span", { class: "ws-cell-meta" }, `${unit.openWorkOrders} open request${unit.openWorkOrders === 1 ? "" : "s"}`) : null),
    h("td", { class: "ws-money" }, compactMoney(unit.marketRentCents)),
    h("td", { class: "ws-money" }, unit.balanceCents === null ? "—" : compactMoney(unit.balanceCents)),
    h(
      "td",
      { class: "ws-lease" },
      unit.leaseStart
        ? [
            `${date(unit.leaseStart, "numeric")} –`,
            h("span", { class: "ws-cell-meta" }, unit.leaseEnd ? date(unit.leaseEnd, "numeric") : "Month to month"),
          ]
        : "—",
    ),
    h("td", {}, unit.occupied ? pill("Occupied", "success") : pill("Vacant", "warning")),
  );
}

/* ------------------------------------------------------------------ *
 * Tenants
 * ------------------------------------------------------------------ */

export async function managerTenants(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const propertyId = params.get("propertyId") ?? "";
  let search = params.get("search") ?? "";
  let balance = params.get("balance") ?? "all";
  let page = 0;

  const [data, props] = await Promise.all([manager.tenants({ propertyId: propertyId || undefined }), manager.properties()]);
  const tenants = data.tenants;
  const owing = tenants.filter((t) => t.balanceCents > 0);
  const autopay = tenants.filter((t) => t.autopay).length;

  const host = h("div", { class: "ws-panel ws-panel--rows", "aria-live": "polite" });
  const setUrl = () => {
    const next = new URLSearchParams(location.search);
    search ? next.set("search", search) : next.delete("search");
    balance === "all" ? next.delete("balance") : next.set("balance", balance);
    const qs = next.toString();
    history.replaceState({}, "", qs ? `/manage/tenants?${qs}` : "/manage/tenants");
  };

  const draw = () => {
    const needle = search.toLowerCase();
    const rows = tenants.filter(
      (t) =>
        (balance === "all" || (balance === "owing" ? t.balanceCents > 0 : t.balanceCents <= 0)) &&
        (!needle || [t.name, t.email, t.unitLabel, t.phone ?? ""].some((v) => v.toLowerCase().includes(needle))),
    );
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    render(
      host,
      h(
        "div",
        { class: "ws-table-wrap" },
        h(
          "table",
          { class: "ws-table ws-table--tenants" },
          h("caption", { class: "visually-hidden" }, "Residents"),
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, "Tenant"),
              h("th", { scope: "col", class: "ws-col-68" }, "Unit"),
              h("th", { scope: "col" }, "Contact"),
              h("th", { scope: "col", class: "ws-col-130" }, "Rent"),
              h("th", { scope: "col", class: "ws-col-130" }, "Balance"),
              h("th", { scope: "col" }, "Autopay"),
              h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")),
            ),
          ),
          h("tbody", {}, ...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(tenantRow)),
        ),
      ),
      rows.length === 0 ? h("p", { class: "ws-empty" }, "No residents match that filter.") : null,
      pager({ page, pageSize: PAGE_SIZE, total: rows.length, noun: "residents", onPage: (n) => { page = n; draw(); } }),
    );
  };

  render(
    mount,
    wsHeader(
      "Tenants",
      "Everyone with an active lease, how to reach them, and where their account stands. Use ⋯ on a row to edit, message, or add a charge.",
      can("portfolio:manage")
        ? h(
            "div",
            { class: "ws-toolbar" },
            wsButton("+ New Lease", {
              onClick: async () => {
                const pf = await import("./manager-portfolio.ts");
                const unit = await pf.pickVacantUnit();
                if (unit) await pf.openLeaseDialog(unit);
              },
            }),
          )
        : undefined,
    ),
    kpiRow([
      kpi("Residents", String(tenants.length), "Active leases"),
      kpi("Owing", String(owing.length), "Balance above zero", "/manage/tenants?balance=owing"),
      kpi("On Autopay", String(autopay), `${percent(tenants.length ? autopay / tenants.length : 0)} of residents`),
      kpi("Owed in Total", compactMoney(owing.reduce((s, t) => s + t.balanceCents, 0)), "Across all balances"),
    ]),
    h(
      "div",
      { class: "ws-filters", role: "search" },
      propertyFilter(props.properties, propertyId, "/manage/tenants"),
      selectField({
        label: "Balance",
        value: balance,
        choices: [
          { value: "all", label: "All Balances" },
          { value: "owing", label: "Owing" },
          { value: "square", label: "Paid up or in credit" },
        ],
        onChange: (v) => { balance = v; page = 0; setUrl(); draw(); },
      }),
      searchField({ label: "Search residents", placeholder: "Search name, email, unit or phone", value: search, onSearch: (v) => { search = v; page = 0; setUrl(); draw(); } }),
    ),
    host,
  );
  draw();
}

function tenantRow(t: TenantRow): HTMLElement {
  return clickableRow(
    `/manage/tenancy/${t.tenancyId}`,
    `${t.name}, unit ${t.unitLabel}`,
    h("td", {}, t.name, h("span", { class: "ws-cell-meta" }, `${t.propertyName} · since ${date(t.leaseStart, "numeric")}`)),
    h("td", {}, t.unitLabel),
    h("td", {}, t.email, t.phone ? h("span", { class: "ws-cell-meta" }, t.phone) : null),
    h("td", { class: "ws-money" }, compactMoney(t.monthlyRentCents)),
    h("td", { class: ["ws-money", t.balanceCents > 0 && "ws-tone--warning"] }, compactMoney(t.balanceCents)),
    h("td", {}, t.autopay ? pill("On", "success") : pill("Off", "muted")),
    h(
      "td",
      { class: "ws-row-actions" },
      rowMenu(t.name, [
        ["Open lease", () => navigate(`/manage/tenancy/${t.tenancyId}`)],
        can("portfolio:manage") ? ["Edit contact details", () => openEditResidentDialog({ userId: t.userId, name: t.name, email: t.email, phone: t.phone })] : null,
        can("portfolio:manage") ? ["New temporary password", () => void issueNewPassword({ userId: t.userId, name: t.name, email: t.email })] : null,
        can("ledger:write:discretionary") ? ["Add a charge or credit", () => openAdjustDialog({ tenancyId: t.tenancyId, unitLabel: t.unitLabel, residentName: t.name }, () => navigate(`/manage/tenancy/${t.tenancyId}`))] : null,
        state.user?.role === "manager"
          ? ["Message", () => void openNewThreadDialog({ tenancyId: t.tenancyId, subject: `Your account — unit ${t.unitLabel}`, topic: "general" })]
          : null,
      ]),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

const AUDIENCES: Array<{ audience: string; format: string; title: string; detail: string }> = [
  { audience: "accountant", format: "csv", title: "Accountant ledger", detail: "Every entry for the period, one row each, with categories — ready for a spreadsheet." },
  { audience: "owner", format: "csv", title: "Owner statement", detail: "Charged, collected and outstanding per unit. No resident contact details." },
  { audience: "legal", format: "json", title: "Legal record", detail: "The full, time-stamped record with who did what and why, for a dispute or a court file." },
];

export async function managerReports(mount: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const period = params.get("period") ?? currentPeriod();
  const propertyId = params.get("propertyId") ?? "";

  const [roll, props, audit] = await Promise.all([
    manager.rentRoll({ period, propertyId: propertyId || undefined, limit: 1000 }),
    manager.properties(),
    manager.audit().catch(() => ({ entries: [] })),
  ]);

  const go = (updates: Record<string, string>) => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(updates)) (v ? next.set(k, v) : next.delete(k));
    const qs = next.toString();
    navigate(qs ? `/manage/reports?${qs}` : "/manage/reports");
  };

  render(
    mount,
    wsHeader(
      "Reports",
      `${formatPeriod(period)} — every figure computed from the ledger when you open it.`,
      selectField({
        label: "Period",
        value: period,
        width: "wide",
        choices: Array.from({ length: 13 }, (_, i) => {
          const key = addMonths(currentPeriod(), -i);
          return { value: key, label: formatPeriod(key) };
        }),
        onChange: (v) => go({ period: v === currentPeriod() ? "" : v }),
      }),
      "ws-header__control--wide",
    ),
    kpiRow([
      kpi("Charged", compactMoney(roll.totals.chargedCents), formatPeriod(period)),
      kpi("Collected", compactMoney(roll.totals.collectedCents), `${percent(roll.totals.collectionRate)} collection rate`),
      kpi("Outstanding", compactMoney(roll.totals.outstandingCents), `${roll.rows.filter((r) => r.dueCents > 0).length} accounts`),
      kpi("Occupied Units", String(roll.totals.units), propertyId ? "At this property" : "Across your portfolio"),
    ]),
    h("div", { class: "ws-filters" }, propertyFilter(props.properties, propertyId, "/manage/reports")),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "downloads" },
      h("h2", { class: "ws-h3", id: "downloads" }, "Downloads"),
      ...AUDIENCES.map((a) =>
        h(
          "div",
          { class: "ws-report" },
          h("div", { class: "ws-report__text" }, h("span", { class: "ws-activity__title" }, a.title), h("span", { class: "ws-activity__detail ws-wrap" }, a.detail)),
          wsButton(`Download ${a.format.toUpperCase()}`, {
            style: "secondary",
            href: manager.exportUrl({ period, propertyId: propertyId || undefined, audience: a.audience, format: a.format }),
            download: true,
          }),
        ),
      ),
      can("charges:post")
        ? h(
            "div",
            { class: "ws-report" },
            h(
              "div",
              { class: "ws-report__text" },
              h("span", { class: "ws-activity__title" }, "Monthly charges"),
              h("span", { class: "ws-activity__detail ws-wrap" }, "Preview and post this period's rent and recurring charges. Safe to run twice."),
            ),
            wsButton("Open", { style: "secondary", href: `/manage/charges?period=${period}` }),
          )
        : null,
    ),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "audit" },
      h("h2", { class: "ws-h3", id: "audit" }, "Audit log"),
      h("p", { class: "ws-sub" }, "Every discretionary action — waivers, manual payments, plans, policy changes — with who did it."),
      audit.entries.length === 0
        ? h("p", { class: "ws-empty" }, "Nothing recorded yet.")
        : h(
            "div",
            { class: "ws-activity" },
            ...audit.entries.slice(0, 25).map((entry) =>
              h(
                "div",
                { class: "ws-activity__item" },
                h("span", { class: "ws-activity__dot", "aria-hidden": "true" }, "●"),
                h(
                  "span",
                  { class: "ws-activity__text" },
                  h("span", { class: "ws-activity__title" }, titleCase(entry.action.replace(/\./g, " "))),
                  h("span", { class: "ws-activity__detail" }, `${entry.actor_name ?? "System"}${entry.actor_role ? ` · ${entry.actor_role}` : ""} · ${dateTime(entry.occurred_at)}`),
                ),
                h("span", { class: "ws-activity__time" }, timeAgo(entry.occurred_at)),
              ),
            ),
          ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export async function managerSettings(mount: HTMLElement): Promise<void> {
  const user = state.user!;
  const policies = can("policy:configure") ? (await manager.lateFeePolicies()).policies : [];

  const link = (href: string, title: string, detail: string) =>
    h(
      "a",
      { class: "ws-report ws-report--link", href, onClick: linkHandler(href) },
      h("span", { class: "ws-report__text" }, h("span", { class: "ws-activity__title" }, title), h("span", { class: "ws-activity__detail ws-wrap" }, detail)),
      h("span", { class: "ws-report__go", "aria-hidden": "true" }, "→"),
    );

  render(
    mount,
    wsHeader("Settings", "Your account, who can see what, and the rules the ledger applies."),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "account" },
      h("h2", { class: "ws-h3", id: "account" }, "Account"),
      h(
        "dl",
        { class: "ws-facts", style: { background: "var(--color-card)" } },
        fact("Name", user.displayName),
        fact("Email", user.email),
        fact("Role", state.roleLabel || user.role),
        fact("Organization", user.organizationName),
      ),
      link("/change-password", "Change password", "Set a new password for this account."),
    ),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "access-privacy" },
      h("h2", { class: "ws-h3", id: "access-privacy" }, "Access and privacy"),
      can("staff:manage") ? link("/manage/access", "Who can see what", "The roles, what each can read and change, and who holds them at each property.") : null,
      can("data:import") ? link("/manage/import", "Import records", "Bring properties, leases and account history over from RentRedi or a spreadsheet.") : null,
      link("/privacy", "What this portal shares", "The outside services this portal talks to (almost none), and the one cookie it sets."),
    ),
    can("rentroll:read") && user.role === "manager" ? screeningSection() : null,
    policies.length
      ? h(
          "section",
          { class: "ws-panel", "aria-labelledby": "late-fees" },
          h("h2", { class: "ws-h3", id: "late-fees" }, "Late-fee policy"),
          h("p", { class: "ws-sub" }, "The default for each property. A lease can have its own terms (for example a commercial lease charged after the 1st): set them on the lease's page. Every change is recorded in the audit log, and residents see the terms in plain words on their account."),
          ...policies.map(policyForm),
        )
      : null,
  );
}

function fact(label: string, value: string): HTMLElement {
  return h("div", { class: "ws-facts__row" }, h("dt", { class: "ws-facts__label" }, label), h("dd", { class: "ws-facts__value", style: { margin: "0" } }, value));
}

type Policy = Awaited<ReturnType<typeof manager.lateFeePolicies>>["policies"][number];

function policyForm(policy: Policy): HTMLElement {
  const id = policy.propertyId.slice(0, 8);
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  const enabled = h("input", { type: "checkbox", id: `lf-on-${id}`, checked: policy.enabled });
  const grace = h("input", { class: "input", id: `lf-grace-${id}`, type: "number", min: "0", max: "30", value: String(policy.graceDays) });
  const feeType = h(
    "select",
    { class: "select", id: `lf-type-${id}` },
    h("option", { value: "flat", selected: policy.feeType === "flat" }, "Flat amount"),
    h("option", { value: "percent", selected: policy.feeType === "percent" }, "Percent of balance"),
  );
  const flat = h("input", { class: "input", id: `lf-flat-${id}`, inputmode: "decimal", value: dollars(policy.flatCents) });
  const pct = h("input", { class: "input", id: `lf-pct-${id}`, type: "number", step: "0.5", min: "0", max: "25", value: String(policy.percent) });
  const max = h("input", { class: "input", id: `lf-max-${id}`, inputmode: "decimal", value: dollars(policy.maxCents) });
  const min = h("input", { class: "input", id: `lf-min-${id}`, inputmode: "decimal", value: dollars(policy.minBalanceCents) });
  const summary = h("p", { class: "ws-sub", "aria-live": "polite" }, policy.plainLanguage);
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const save = h("button", { class: "ws-btn ws-btn--primary", type: "submit" }, "Save policy");

  const syncType = () => {
    flat.closest(".field")?.toggleAttribute("hidden", feeType.value !== "flat");
    pct.closest(".field")?.toggleAttribute("hidden", feeType.value !== "percent");
  };
  feeType.addEventListener("change", syncType);

  const field = (label: string, input: HTMLElement, forId: string) =>
    h("label", { class: "field", for: forId }, h("span", { class: "field__label" }, label), input);

  const form = h(
    "form",
    {
      class: "ws-policy",
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.hidden = true;
        const flatCents = parseAmount(flat.value);
        const maxCents = parseAmount(max.value);
        const minCents = parseAmount(min.value);
        if (flatCents === null || maxCents === null || minCents === null) {
          error.textContent = "Amounts must be dollars, like 50 or 50.00.";
          error.hidden = false;
          return;
        }
        save.disabled = true;
        try {
          const result = await manager.saveLateFeePolicy({
            propertyId: policy.propertyId,
            enabled: enabled.checked,
            graceDays: Number(grace.value),
            feeType: feeType.value,
            flatCents,
            percent: Number(pct.value || 0),
            dailyCents: policy.dailyCents,
            maxCents,
            minBalanceCents: minCents,
          });
          summary.textContent = result.plainLanguage;
          toast(`Late-fee policy saved for ${policy.propertyName}.`, "good");
        } catch (caught) {
          error.textContent = caught instanceof ApiError ? caught.message : "Could not save the policy.";
          error.hidden = false;
        } finally {
          save.disabled = false;
        }
      },
    },
    h("h3", { class: "ws-activity__title" }, policy.propertyName),
    summary,
    h("label", { class: "checkbox", for: `lf-on-${id}` }, enabled, h("span", {}, "Charge late fees at this property")),
    h(
      "div",
      { class: "ws-policy__grid" },
      field("Grace period (days)", grace, `lf-grace-${id}`),
      field("Fee type", feeType, `lf-type-${id}`),
      field("Flat fee ($)", flat, `lf-flat-${id}`),
      field("Percent of balance", pct, `lf-pct-${id}`),
      field("Most per month ($)", max, `lf-max-${id}`),
      field("Ignore balances under ($)", min, `lf-min-${id}`),
    ),
    error,
    h("div", {}, save),
  );
  queueMicrotask(syncType);
  return form;
}
