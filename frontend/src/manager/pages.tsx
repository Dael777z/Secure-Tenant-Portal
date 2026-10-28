// The manager screens: Dashboard, Properties (+ detail), Rent Roll, Tenants,
// Lease, Maintenance and Updates. Ported from the resident-portal reference
// views (manager-dashboard, -portfolio, -rentroll, -directory, -maintenance,
// -exceptions), cut down to what the team's schema stores.
import { useMemo, useState } from "react";
import { managerApi, receiptUrl, REQUEST_PRIORITIES, REQUEST_STATUSES, REQUEST_TYPES, type MaintenanceRow, type RequestStatus, type TenantRow, type UnitRow, type UpdateRow } from "./api";
import { downloadCsv } from "./finance-api";
import { MoreMenu, tenantStages, type TenantStage } from "./ops";
import type { LedgerEntry } from "../types";
import { financeApi } from "./finance-api";
import { GettingStarted } from "./onboarding";
import { SortTh, useSort } from "./sort";
import { Breadcrumbs, Empty, Kpi, Loading, LocalError, PageHeader, StatusPill, ViewCard, isoDate, money, percent, timeAgo, todayIso, useLoad, useManager, type MaintenanceView, type TenantView } from "./ui";

/* ------------------------------------------------------------------ *
 * Quick actions — the common jobs, one click from any screen
 * ------------------------------------------------------------------ */

export function QuickActions() {
  const { open, can, go } = useManager();
  const actions: Array<[string, () => void, boolean]> = [
    ["+ New lease", () => open({ kind: "lease" }), can("users:provision")],
    ["Set up a property", () => go({ name: "setup" }), can("users:provision")],
    ["+ Add property", () => open({ kind: "property" }), can("users:provision")],
    ["+ Add unit", () => open({ kind: "unit" }), can("users:provision")],
    ["Record a payment", () => open({ kind: "payment" }), can("ledger:adjust")],
    ["+ Add expense", () => open({ kind: "expense" }), can("ledger:adjust")],
    ["+ Invite tenant", () => open({ kind: "tenant" }), can("users:provision")],
    ["Maintenance request", () => open({ kind: "maintenance" }), can("maintenance:manage")],
  ];
  return (
    <nav className="mgr-quick" aria-label="Quick actions">
      {actions
        .filter(([, , allowed]) => allowed)
        .map(([label, onClick], i) => (
          <button key={label} type="button" className={`mgr-btn ${i === 0 ? "mgr-btn--primary" : "mgr-btn--secondary"}`} onClick={onClick}>
            {label}
          </button>
        ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export function DashboardPage({ name }: { name: string }) {
  const { go } = useManager();
  const { data, error } = useLoad(() => managerApi.dashboard());
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${hello}, ${name.split(" ")[0]}. Your portfolio at a glance.`} />
      <QuickActions />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <GettingStarted data={data} />
          <div className="mgr-kpis">
            <Kpi label="Total Properties" value={String(data.properties)} note="Across your portfolio" onClick={() => go({ name: "properties" })} />
            <Kpi label="Total Units" value={String(data.units)} note="All residential units" onClick={() => go({ name: "rent-roll" })} />
            <Kpi label="Occupied" value={String(data.occupied)} note={`${percent(data.occupied, data.units)} occupancy rate`} />
            <Kpi label="Vacant" value={String(data.vacant)} note={`${percent(data.vacant, data.units)} available to lease`} onClick={() => go({ name: "rent-roll", filter: "vacant" })} />
          </div>
          <div className="mgr-kpis">
            <Kpi
              label="Rent Collected"
              value={money(data.collectedThisMonth, false)}
              note={`${percent(data.collectedThisMonth, data.expectedThisMonth)} of ${money(data.expectedThisMonth, false)} expected this month`}
              tone="good"
              onClick={() => go({ name: "rent-roll", filter: "current" })}
            />
            <Kpi label="Outstanding" value={money(data.outstanding, false)} note="Owed across all leases" tone={data.outstanding > 0 ? "warn" : undefined} onClick={() => go({ name: "rent-roll", filter: "owing" })} />
            <Kpi label="Overdue Accounts" value={String(data.overdueAccounts)} note="See updates on payments" tone={data.overdueAccounts > 0 ? "warn" : undefined} onClick={() => go({ name: "updates" })} />
            <Kpi label="Open Maintenance" value={String(data.openMaintenance)} note="New or in progress" onClick={() => go({ name: "maintenance" })} />
          </div>
          <div className="mgr-columns">
            <section className="mgr-card" aria-labelledby="mgr-activity">
              <h2 className="mgr-h2" id="mgr-activity">Recent Activity</h2>
              {data.recentActivity.length === 0 ? (
                <Empty>Nothing has happened yet.</Empty>
              ) : (
                <ul className="mgr-activity">
                  {data.recentActivity.map((a, i) => (
                    <li key={i} className={`mgr-activity__item mgr-activity__item--${a.kind}`}>
                      <span className="mgr-activity__dot" aria-hidden="true" />
                      <div>
                        <strong>{a.title}</strong>
                        <span className="mgr-muted">{a.detail}</span>
                      </div>
                      <time dateTime={a.at} className="mgr-muted">{timeAgo(a.at)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="mgr-card" aria-labelledby="mgr-needs">
              <div className="mgr-card__head">
                <h2 className="mgr-h2" id="mgr-needs">Needs your attention</h2>
                <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "updates" })}>
                  View all updates
                </button>
              </div>
              <UpdateList updates={data.updates.slice(0, 5)} compact />
            </section>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Properties
 * ------------------------------------------------------------------ */

export function PropertiesPage() {
  const { go, open, can } = useManager();
  const { data, error } = useLoad(() => managerApi.properties());
  return (
    <>
      <PageHeader title="Properties" subtitle="Every building you manage, with occupancy and what is owed." />
      <QuickActions />
      {!data ? (
        <Loading error={error} />
      ) : data.length === 0 ? (
        <Empty>No properties yet. Use “+ Add property” to start.</Empty>
      ) : (
        <div className="mgr-grid">
          {data.map((p) => (
            <article key={p.id} className="mgr-card mgr-property">
              <button type="button" className="mgr-property__open" onClick={() => go({ name: "property", id: p.id })}>
                <h2 className="mgr-h2">{p.name}</h2>
                <p className="mgr-muted">{p.address}</p>
              </button>
              <dl className="mgr-stats">
                <div>
                  <dt>Units</dt>
                  <dd>{p.units}</dd>
                </div>
                <div>
                  <dt>Occupied</dt>
                  <dd>
                    {p.occupied} <span className="mgr-muted">({percent(p.occupied, p.units)})</span>
                  </dd>
                </div>
                <div>
                  <dt>Monthly rent</dt>
                  <dd>{money(p.monthlyRent, false)}</dd>
                </div>
                <div>
                  <dt>Outstanding</dt>
                  <dd className={p.outstanding > 0 ? "mgr-owes" : undefined}>{money(p.outstanding, false)}</dd>
                </div>
              </dl>
              <div className="mgr-occupancy" role="img" aria-label={`${percent(p.occupied, p.units)} occupied`}>
                <span style={{ width: percent(p.occupied, p.units) }} />
              </div>
              <div className="mgr-row-actions">
                <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "property", id: p.id })}>
                  View units
                </button>
                {can("users:provision") && (
                  <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "unit", propertyId: p.id })}>
                    + Add unit
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function PropertyPage({ id }: { id: number }) {
  const { open, can } = useManager();
  const properties = useLoad(() => managerApi.properties());
  const units = useLoad(() => managerApi.units(id), [id]);
  const property = properties.data?.find((p) => p.id === id);

  if (properties.data && !property) return <Empty>That property was not found.</Empty>;
  if (!property || !units.data) return <Loading error={properties.error ?? units.error} />;

  return (
    <>
      <Breadcrumbs trail={[["Properties", { name: "properties" }], [property.name, null]]} />
      <PageHeader
        title={property.name}
        subtitle={property.address}
        actions={
          can("users:provision") && (
            <>
              <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "property", id, name: property.name, address: property.address })}>
                Edit property
              </button>
              <button
                type="button"
                className="mgr-btn mgr-btn--danger-ghost"
                onClick={() =>
                  open({
                    kind: "confirm",
                    title: "Delete property",
                    body: `Delete ${property.name} and its ${property.units} unit${property.units === 1 ? "" : "s"}? This only works if none of its units was ever leased.`,
                    confirmLabel: "Delete property",
                    run: () => managerApi.deleteProperty(id),
                    done: `${property.name} deleted.`,
                    after: { name: "properties" },
                  })
                }
              >
                Delete property
              </button>
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "unit", propertyId: id })}>
                + Add unit
              </button>
            </>
          )
        }
      />
      <div className="mgr-kpis">
        <Kpi label="Units" value={String(property.units)} />
        <Kpi label="Occupied" value={String(property.occupied)} note={`${percent(property.occupied, property.units)} occupancy`} />
        <Kpi label="Monthly rent" value={money(property.monthlyRent, false)} note="From active leases" />
        <Kpi label="Outstanding" value={money(property.outstanding, false)} tone={property.outstanding > 0 ? "warn" : undefined} />
      </div>
      <section className="mgr-card">
        <h2 className="mgr-h2">Units</h2>
        <UnitTable units={units.data} showProperty={false} />
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Rent roll
 * ------------------------------------------------------------------ */

function UnitTable({ units, showProperty }: { units: UnitRow[]; showProperty: boolean }) {
  const { go, open, can } = useManager();
  const STATUS_ORDER = { owing: 0, current: 1, vacant: 2 } as const;
  const sorter = useSort(showProperty ? "rent-roll" : "property-units", units, {
    unit: (u) => u.unitNum,
    property: (u) => u.propertyName,
    residents: (u) => u.tenants[0]?.name ?? null,
    rent: (u) => u.monthlyRent,
    balance: (u) => (u.leaseId === null ? null : u.balance),
    status: (u) => STATUS_ORDER[u.status],
    ends: (u) => u.endDate,
  }, { key: showProperty ? "property" : "unit", dir: "asc" });
  if (units.length === 0) return <Empty>No units match.</Empty>;
  return (
    <div className="mgr-table-wrap">
      <table className="mgr-table">
        <thead>
          <tr>
            <SortTh sorter={sorter} k="unit">Unit</SortTh>
            {showProperty && <SortTh sorter={sorter} k="property">Property</SortTh>}
            <SortTh sorter={sorter} k="residents">Residents</SortTh>
            <SortTh sorter={sorter} k="rent" num>Rent</SortTh>
            <SortTh sorter={sorter} k="balance" num>Balance</SortTh>
            <SortTh sorter={sorter} k="status">Status</SortTh>
            <SortTh sorter={sorter} k="ends">Lease</SortTh>
            <th scope="col"><span className="mgr-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {sorter.rows.map((u) => (
            <tr key={u.id}>
              <th scope="row">
                <a
                  href={`#/units/${u.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go({ name: "unit", id: u.id, tab: "overview" });
                  }}
                >
                  {u.unitNum}
                </a>
                {u.openRequests > 0 && (
                  <span className="mgr-badge" title={`${u.openRequests} open maintenance request${u.openRequests === 1 ? "" : "s"}`}>
                    {u.openRequests} open
                  </span>
                )}
              </th>
              {showProperty && <td>{u.propertyName}</td>}
              <td>{u.tenants.length ? u.tenants.map((t) => t.name).join(", ") : <span className="mgr-muted">—</span>}</td>
              <td className="mgr-num">{u.monthlyRent === null ? "—" : money(u.monthlyRent)}</td>
              <td className={`mgr-num${u.balance > 0 ? " mgr-owes" : ""}`}>{u.leaseId === null ? "—" : money(u.balance)}</td>
              <td>
                <StatusPill status={u.status} />
              </td>
              <td className="mgr-muted">{u.startDate ? `${isoDate(u.startDate)} – ${u.endDate ? isoDate(u.endDate) : "month to month"}` : "—"}</td>
              <td className="mgr-row-actions">
                {u.leaseId !== null ? (
                  <>
                    <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: u.leaseId! })}>
                      Open lease
                    </button>
                    {u.balance > 0 && can("ledger:adjust") && (
                      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "payment", leaseId: u.leaseId! })}>
                        Record payment
                      </button>
                    )}
                  </>
                ) : (
                  can("users:provision") && (
                    <>
                      <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "lease", unitId: u.id })}>
                        New lease
                      </button>
                      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "unit", id: u.id, propertyId: u.propertyId, unitNum: u.unitNum })}>
                        Rename
                      </button>
                      <button
                        type="button"
                        className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                        onClick={() =>
                          open({
                            kind: "confirm",
                            title: "Delete unit",
                            body: `Delete Unit ${u.unitNum} at ${u.propertyName}? Its maintenance requests go with it. A unit that was ever leased stays on record.`,
                            confirmLabel: "Delete unit",
                            run: () => managerApi.deleteUnit(u.id),
                            done: `Unit ${u.unitNum} deleted.`,
                          })
                        }
                      >
                        Delete
                      </button>
                    </>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RentRollPage({ filter }: { filter?: "owing" | "current" | "vacant" }) {
  const { go } = useManager();
  const units = useLoad(() => managerApi.units());
  const properties = useLoad(() => managerApi.properties());
  const expiring = useLoad(() => financeApi.expiring(90));
  const [property, setProperty] = useState("");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (units.data ?? []).filter(
      (u) =>
        (!filter || u.status === filter) &&
        (!property || String(u.propertyId) === property) &&
        (!q || u.unitNum.toLowerCase().includes(q) || u.tenants.some((t) => t.name.toLowerCase().includes(q))),
    );
  }, [units.data, filter, property, search]);

  const totals = rows.reduce((acc, u) => ({ rent: acc.rent + (u.monthlyRent ?? 0), owed: acc.owed + u.balance }), { rent: 0, owed: 0 });
  const counts = (units.data ?? []).reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.status]: (acc[u.status] ?? 0) + 1 }), {});
  const tabs: Array<[string, "owing" | "current" | "vacant" | undefined, number]> = [
    ["All units", undefined, units.data?.length ?? 0],
    ["Owes rent", "owing", counts.owing ?? 0],
    ["Paid up", "current", counts.current ?? 0],
    ["Vacant", "vacant", counts.vacant ?? 0],
  ];

  return (
    <>
      <PageHeader title="Units" subtitle="Every unit, who lives there, and where each account stands today. Open a unit for its leases, charges and documents." />
      <QuickActions />
      {units.data && (
        <div className="mgr-kpis">
          <Kpi label="Total units" value={String(units.data.length)} note={`Across ${new Set(units.data.map((u) => u.propertyId)).size} propert${new Set(units.data.map((u) => u.propertyId)).size === 1 ? "y" : "ies"}`} onClick={() => go({ name: "rent-roll" })} />
          <Kpi label="Rented" value={String(units.data.length - (counts.vacant ?? 0))} note={`${percent(units.data.length - (counts.vacant ?? 0), units.data.length)} occupancy`} tone="good" />
          <Kpi label="Expiring soon" value={expiring.data ? String(expiring.data.length) : "…"} note="Leases ending in 90 days" tone={expiring.data?.length ? "warn" : undefined} onClick={() => go({ name: "renewals", days: 90 })} />
          <Kpi label="Vacant" value={String(counts.vacant ?? 0)} note="Ready to lease" onClick={() => go({ name: "rent-roll", filter: "vacant" })} />
        </div>
      )}
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="Filter by status">
          {tabs.map(([label, value, count]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`mgr-tab${filter === value ? " mgr-tab--active" : ""}`}
              onClick={() => go({ name: "rent-roll", filter: value })}
            >
              {label} <span className="mgr-tab__count">{count}</span>
            </button>
          ))}
        </div>
        <div className="mgr-toolbar__filters">
          <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}>
            <option value="">All properties</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input type="search" aria-label="Search units or residents" placeholder="Search unit or resident" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {!units.data ? (
        <Loading error={units.error} />
      ) : (
        <section className="mgr-card">
          <UnitTable units={rows} showProperty />
          <p className="mgr-table-foot">
            {rows.length} unit{rows.length === 1 ? "" : "s"} · {money(totals.rent)} monthly rent · <span className={totals.owed > 0 ? "mgr-owes" : undefined}>{money(totals.owed)} outstanding</span>
          </p>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tenants
 * ------------------------------------------------------------------ */

const TENANT_VIEW_LABEL: Record<TenantStage, string> = { current: "Current", "moving-in": "Moving in", leaving: "Leaving", prior: "No lease" };

export function TenantsPage({ view }: { view?: TenantView }) {
  const { go, open, can, changed } = useManager();

  // Tenants sign up from a link the office sends them. A new link replaces the old one.
  async function copySignUpLink(t: TenantRow) {
    try {
      const { inviteLink } = await managerApi.newSignUpLink(t.id);
      await navigator.clipboard.writeText(inviteLink);
      changed(`Sign-up link for ${t.name} copied. Send it to ${t.email}; any earlier link stops working.`);
    } catch {
      changed(`Could not copy a sign-up link for ${t.name}. Try again.`);
    }
  }

  // A signed-up tenant who cannot sign in. Their password stops working once this runs.
  function resetSignIn(t: TenantRow) {
    open({
      kind: "confirm",
      title: "Reset sign-in",
      body: `Reset ${t.name}'s sign-in? Their current password stops working and they are signed out everywhere. You get a link to send them so they can choose a new password.`,
      confirmLabel: "Reset and copy link",
      run: async () => {
        const { inviteLink } = await managerApi.resetSignIn(t.id);
        try {
          await navigator.clipboard.writeText(inviteLink);
        } catch {
          // The reset is done; keep the dialog open with the link so it can be copied by hand.
          throw new LocalError(`Sign-in reset, but the link could not be copied. Send ${t.email} this link: ${inviteLink}`);
        }
      },
      done: `Sign-in reset for ${t.name}. The link is copied; send it to ${t.email}.`,
    });
  }
  const { data, error } = useLoad(() => managerApi.tenants());
  const units = useLoad(() => managerApi.units());
  const [search, setSearch] = useState("");
  const [showBalance, setShowBalance] = useState(true);
  const today = todayIso();
  const stages = useMemo(() => tenantStages(data ?? [], units.data ?? [], today), [data, units.data, today]);
  const count = (v: TenantStage) => (data ?? []).filter((t) => stages.get(t.id)?.stage === v).length;
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (data ?? []).filter((t) => (!view || stages.get(t.id)?.stage === view) && (!q || t.name.toLowerCase().includes(q) || t.email.includes(q) || (t.unitLabel ?? "").toLowerCase().includes(q))),
    [data, q, view, stages],
  );
  const sorter = useSort("tenants", rows, {
    name: (t) => t.name,
    contact: (t) => t.email,
    unit: (t) => t.unitLabel,
    start: (t) => stages.get(t.id)?.startDate ?? null,
    end: (t) => stages.get(t.id)?.endDate ?? null,
    balance: (t) => (t.leaseId === null ? null : t.balance),
    account: (t) => (t.signedUp ? 1 : 0),
  }, { key: "name", dir: "asc" });
  const setView = (v: TenantStage) => go({ name: "tenants", view: v === view ? undefined : v });

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Everyone with a resident account, where their lease stands, and whether they have signed up yet."
        actions={
          can("users:provision") && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "tenant" })}>
              + Invite tenant
            </button>
          )
        }
      />
      {data && units.data && (
        <div className="mgr-viewcards">
          {(["current", "moving-in", "leaving", "prior"] as const).map((v) => (
            <ViewCard
              key={v}
              label={TENANT_VIEW_LABEL[v]}
              value={String(count(v))}
              note={v === "leaving" ? "Lease ends in 60 days" : v === "prior" ? "Prior or not leased yet" : `View ${TENANT_VIEW_LABEL[v].toLowerCase()}`}
              active={view === v}
              onClick={() => setView(v)}
              tone={v === "leaving" && count(v) ? "warn" : undefined}
            />
          ))}
        </div>
      )}
      <div className="mgr-toolbar">
        <input type="search" aria-label="Search tenants" placeholder="Search name, email or unit" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="mgr-toolbar__filters">
          {view && (
            <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "tenants" })}>
              Show everyone
            </button>
          )}
          <label className="mgr-check mgr-check--inline">
            <input type="checkbox" checked={showBalance} onChange={(e) => setShowBalance(e.target.checked)} />
            Show balance due
          </label>
          <button
            type="button"
            className="mgr-btn mgr-btn--secondary mgr-btn--small"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv("tenants.csv", [
                ["Name", "Email", "Phone", "Unit", "Lease start", "Lease end", "Status", "Balance", "Account"],
                ...sorter.rows.map((t) => {
                  const s = stages.get(t.id);
                  return [t.name, t.email, t.phone ?? "", t.unitLabel ?? "", s?.startDate ?? "", s?.endDate ?? "", s ? TENANT_VIEW_LABEL[s.stage] : "", t.leaseId === null ? "" : t.balance, t.signedUp ? "Signed up" : "Invited"];
                }),
              ])
            }
          >
            Export CSV
          </button>
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <section className="mgr-card">
          {rows.length === 0 ? (
            <Empty>No tenants match.</Empty>
          ) : (
            <div className="mgr-table-wrap">
              <table className="mgr-table">
                <thead>
                  <tr>
                    <SortTh sorter={sorter} k="name">Name</SortTh>
                    <SortTh sorter={sorter} k="contact">Contact</SortTh>
                    <SortTh sorter={sorter} k="unit">Unit</SortTh>
                    <SortTh sorter={sorter} k="end">Lease</SortTh>
                    {showBalance && <SortTh sorter={sorter} k="balance" num>Balance</SortTh>}
                    <SortTh sorter={sorter} k="account">Account</SortTh>
                    <th scope="col"><span className="mgr-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorter.rows.map((t) => {
                    const s = stages.get(t.id);
                    return (
                      <tr key={t.id}>
                        <th scope="row">
                          <a
                            href={`#/tenants/${t.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              go({ name: "tenant", id: t.id, tab: "overview" });
                            }}
                          >
                            {t.name}
                          </a>
                        </th>
                        <td>
                          <a href={`mailto:${t.email}`}>{t.email}</a>
                          {t.phone && <div className="mgr-muted">{t.phone}</div>}
                        </td>
                        <td>{t.unitLabel ?? <span className="mgr-muted">No lease</span>}</td>
                        <td>
                          {s?.startDate ? `${isoDate(s.startDate)} – ${s.endDate ? isoDate(s.endDate) : "month to month"}` : "—"}
                          {s?.daysLeft !== null && s?.daysLeft !== undefined && s.daysLeft <= 60 && (
                            <div>
                              <span className={`mgr-pill mgr-pill--${s.daysLeft < 0 ? "late" : "submitted"}`}>{s.daysLeft < 0 ? "Ended" : `${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left`}</span>
                            </div>
                          )}
                        </td>
                        {showBalance && <td className={`mgr-num${t.balance > 0 ? " mgr-owes" : ""}`}>{t.leaseId === null ? "—" : money(t.balance)}</td>}
                        <td>{t.signedUp ? <span className="mgr-pill mgr-pill--current">Signed up</span> : <span className="mgr-pill mgr-pill--submitted">Invited</span>}</td>
                        <td className="mgr-row-actions">
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "tenant", id: t.id, tab: "overview" })}>
                            Open
                          </button>
                          {can("messages:manage") && (
                            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "messages", tenantId: t.id })}>
                              Message
                            </button>
                          )}
                          {can("users:provision") && (
                            <MoreMenu
                              items={[
                                ...(t.signedUp ? [["Reset sign-in", () => resetSignIn(t)] as [string, () => void]] : [["Copy sign-up link", () => void copySignUpLink(t)] as [string, () => void]]),
                                ["Edit details", () => open({ kind: "editTenant", id: t.id, name: t.name, phone: t.phone })],
                                ...(t.leaseId === null
                                  ? [[
                                      "Delete tenant",
                                      () =>
                                        open({
                                          kind: "confirm",
                                          title: "Delete tenant",
                                          body: `Delete ${t.name} (${t.email})? Their sign-in stops working; their payments and requests stay on record.`,
                                          confirmLabel: "Delete tenant",
                                          run: () => managerApi.deleteTenant(t.id),
                                          done: `${t.name} deleted.`,
                                        }),
                                    ] as [string, () => void]]
                                  : []),
                              ]}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Lease
 * ------------------------------------------------------------------ */

/** "payment-42" → 42; charges have no payment id. */
const paymentIdOf = (entryId: string) => (entryId.startsWith("payment-") ? Number(entryId.slice("payment-".length)) : NaN);

/** On a ledger payment line: open or attach the receipt; undo an office entry. */
function PaymentActions({ leaseId, entry, hasReceipt }: { leaseId: number; entry: LedgerEntry; hasReceipt: boolean }) {
  const { open, can } = useManager();
  const paymentId = paymentIdOf(entry.id);
  if (Number.isNaN(paymentId)) return null;
  const office = entry.confirmation?.startsWith("OFF-") ?? false;
  const label = `${money(entry.amount)} on ${entry.date}${entry.method ? `, ${entry.method}` : ""}`;
  return (
    <>
      {hasReceipt ? (
        <a className="mgr-btn mgr-btn--secondary mgr-btn--small" href={receiptUrl(leaseId, paymentId)} target="_blank" rel="noopener">
          View receipt
        </a>
      ) : (
        can("ledger:adjust") && (
          <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "attachReceipt", leaseId, paymentId, label })}>
            Attach
          </button>
        )
      )}
      {office && can("ledger:adjust") && (
        <button
          type="button"
          className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
          onClick={() =>
            open({
              kind: "confirm",
              title: "Undo payment",
              body: `Undo the office entry ${label} (${entry.confirmation})? The balance goes back up, and its receipt is removed too.`,
              confirmLabel: "Undo payment",
              run: () => managerApi.undoPayment(leaseId, paymentId),
              done: "Payment undone.",
            })
          }
        >
          Undo
        </button>
      )}
    </>
  );
}

export function LeasePage({ id }: { id: number }) {
  const { go, open, can, changed } = useManager();
  const { data, error } = useLoad(() => managerApi.lease(id), [id]);
  const [removing, setRemoving] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  if (!data) return <Loading error={error} />;
  const label = `Unit ${data.unitNum} - ${data.propertyName}`;
  const ended = data.endDate !== null && data.endDate < new Date().toISOString().slice(0, 10);

  async function remove(tenantId: number) {
    setRemoving(tenantId);
    setRemoveError(null);
    try {
      await managerApi.removeTenantFromLease(id, tenantId);
      changed("Resident removed from the lease.");
    } catch {
      setRemoveError("A lease needs at least one resident. Add the new resident first, or end the lease.");
    } finally {
      setRemoving(null);
    }
  }

  const startDay = Number(data.startDate.slice(8, 10));
  return (
    <>
      <Breadcrumbs trail={[["Units", { name: "rent-roll" }], [data.propertyName, { name: "property", id: data.propertyId }], [`Unit ${data.unitNum}`, { name: "unit", id: data.unitId, tab: "overview" }], ["Lease", null]]} />
      <PageHeader
        title={label}
        subtitle={
          <>
            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "property", id: data.propertyId })}>
              {data.propertyName}
            </button>{" "}
            · {data.address}
          </>
        }
        actions={
          <>
            {can("ledger:adjust") && (
              <>
                <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "payment", leaseId: id })}>
                  Record a payment
                </button>
                <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => open({ kind: "charge", leaseId: id, label })}>
                  Add a charge
                </button>
              </>
            )}
            {can("users:provision") && !ended && (
              <>
                <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "rent", leaseId: id, monthlyRent: data.monthlyRent })}>
                  Change rent
                </button>
                <button type="button" className="mgr-btn mgr-btn--danger-ghost" onClick={() => open({ kind: "endLease", leaseId: id, label })}>
                  End lease
                </button>
                <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "leaseDocument", leaseId: id, label })}>
                  Upload signed lease
                </button>
              </>
            )}
          </>
        }
      />
      <div className="mgr-kpis">
        <Kpi label="Balance due" value={money(data.balance)} tone={data.balance > 0 ? "warn" : "good"} note={data.balance > 0 ? "Owed today" : "Paid up"} />
        <Kpi label="Monthly rent" value={money(data.monthlyRent)} note={`Billed on day ${startDay} of each month`} />
        <Kpi label="Lease start" value={isoDate(data.startDate)} />
        <Kpi label="Lease end" value={data.endDate ? isoDate(data.endDate) : "Month to month"} note={ended ? "This lease has ended" : undefined} />
      </div>
      <div className="mgr-columns mgr-columns--lease">
        <section className="mgr-card" aria-labelledby="mgr-residents">
          <div className="mgr-card__head">
            <h2 className="mgr-h2" id="mgr-residents">Residents</h2>
            {can("users:provision") && !ended && (
              <button type="button" className="mgr-btn mgr-btn--link" onClick={() => open({ kind: "addResident", leaseId: id })}>
                + Add resident or cosigner
              </button>
            )}
          </div>
          <ul className="mgr-people-list">
            {data.tenants.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{t.name}</strong> {!t.signedUp && <span className="mgr-pill mgr-pill--submitted">Invited</span>}
                  <div className="mgr-muted">
                    {t.email}
                    {t.phone ? ` · ${t.phone}` : ""}
                  </div>
                </div>
                {can("users:provision") && data.tenants.length > 1 && !ended && (
                  <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" disabled={removing === t.id} onClick={() => void remove(t.id)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {removeError && <p className="mgr-alert mgr-alert--error">{removeError}</p>}
        </section>
        <section className="mgr-card" aria-labelledby="mgr-ledger">
          <h2 className="mgr-h2" id="mgr-ledger">Ledger</h2>
          {data.ledger.length === 0 ? (
            <Empty>No charges yet. Rent is charged from the start date.</Empty>
          ) : (
            <div className="mgr-table-wrap">
              <table className="mgr-table mgr-table--compact">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col">Method</th>
                    <th scope="col" className="mgr-num">Amount</th>
                    <th scope="col" className="mgr-num">Balance</th>
                    <th scope="col">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledger.map((e) => (
                    <tr key={e.id}>
                      <td>{e.date}</td>
                      <td>
                        {e.description}
                        {e.confirmation && <div className="mgr-muted mgr-mono">{e.confirmation}</div>}
                      </td>
                      <td className="mgr-muted">{e.method ?? "—"}</td>
                      <td className={`mgr-num ${e.amount > 0 ? "mgr-credit" : ""}`}>{e.amount > 0 ? `+${money(e.amount)}` : money(e.amount)}</td>
                      <td className="mgr-num">{money(e.balanceAfter)}</td>
                      <td className="mgr-row-actions">
                        <PaymentActions leaseId={id} entry={e} hasReceipt={data.receiptPaymentIds.includes(paymentIdOf(e.id))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Maintenance
 * ------------------------------------------------------------------ */

const STATUS_TEXT = Object.fromEntries(REQUEST_STATUSES) as Record<RequestStatus, string>;
const PRIORITY_TEXT = Object.fromEntries(REQUEST_PRIORITIES) as Record<MaintenanceRow["priority"], string>;
const TYPE_TEXT = Object.fromEntries(REQUEST_TYPES) as Record<MaintenanceRow["requestType"], string>;
const PRIORITY_RANK: Record<MaintenanceRow["priority"], number> = { emergency: 0, high: 1, medium: 2, low: 3, none: 4 };

/** The next step for a request at each stage (the first one is the main button). */
const NEXT_STATUS: Record<RequestStatus, Array<[RequestStatus, string]>> = {
  submitted: [["in_review", "Review"], ["scheduled", "Schedule"]],
  in_review: [["scheduled", "Schedule"], ["in_progress", "Start work"]],
  scheduled: [["in_progress", "Start work"], ["resolved", "Mark completed"]],
  in_progress: [["resolved", "Mark completed"]],
  resolved: [["in_progress", "Reopen"]],
};

export function MaintenancePage({ view = "open" }: { view?: MaintenanceView }) {
  const { open, changed, go } = useManager();
  const { data, error } = useLoad(() => managerApi.maintenance());
  const [property, setProperty] = useState("");
  const [priority, setPriority] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<"newest" | "priority" | "scheduled">("newest");
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const all = data?.requests ?? [];
  const inView = (r: MaintenanceRow, v: MaintenanceView) => (v === "all" ? true : v === "open" ? r.status !== "resolved" : r.status === v);
  const count = (v: MaintenanceView) => all.filter((r) => inView(r, v)).length;
  const properties = [...new Map(all.map((r) => [r.propertyId, r.propertyName])).entries()];
  const requests = all
    .filter((r) => inView(r, view) && (!property || String(r.propertyId) === property) && (!priority || r.priority === priority) && (!type || r.requestType === type))
    .sort((a, b) =>
      sort === "priority"
        ? PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.id - a.id
        : sort === "scheduled"
          ? (a.scheduledFor ?? "9999").localeCompare(b.scheduledFor ?? "9999") || b.id - a.id
          : b.id - a.id,
    );

  async function update(r: MaintenanceRow, change: Parameters<typeof managerApi.updateMaintenance>[1], message: string) {
    setBusy(r.id);
    setFailed(null);
    try {
      await managerApi.updateMaintenance(r.id, change);
      changed(message);
    } catch {
      setFailed("That change did not save. Try again.");
    } finally {
      setBusy(null);
    }
  }
  const setView = (v: MaintenanceView) => go({ name: "maintenance", view: v === "open" ? undefined : v });

  return (
    <>
      <PageHeader
        title="Maintenance"
        subtitle="Requests from residents and the office, from new to completed. Every change shows up in the resident's portal."
        actions={
          <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "maintenance" })}>
            + New request
          </button>
        }
      />
      <div className="mgr-viewcards mgr-viewcards--five">
        {(["submitted", "in_review", "scheduled", "in_progress", "resolved"] as const).map((v) => (
          <ViewCard
            key={v}
            label={STATUS_TEXT[v]}
            value={String(count(v))}
            note={`View ${STATUS_TEXT[v].toLowerCase()}`}
            active={view === v}
            onClick={() => setView(view === v ? "open" : v)}
            tone={v === "submitted" && count(v) ? "warn" : undefined}
          />
        ))}
      </div>
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="Show">
          {(["open", "all"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={`mgr-tab${view === v ? " mgr-tab--active" : ""}`} onClick={() => setView(v)}>
              {v === "open" ? "All open" : "Everything"} <span className="mgr-tab__count">{count(v)}</span>
            </button>
          ))}
        </div>
        <div className="mgr-toolbar__filters">
          <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}>
            <option value="">All properties</option>
            {properties.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All priorities</option>
            {REQUEST_PRIORITIES.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select aria-label="Request type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All request types</option>
            {REQUEST_TYPES.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="newest">Newest first</option>
            <option value="priority">Highest priority first</option>
            <option value="scheduled">Soonest scheduled first</option>
          </select>
          <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Collapse rows" : "Expand rows"}
          </button>
          <button
            type="button"
            className="mgr-btn mgr-btn--secondary mgr-btn--small"
            disabled={requests.length === 0}
            onClick={() =>
              downloadCsv("maintenance.csv", [
                ["Submitted", "Property", "Unit", "From", "Title", "Type", "Priority", "Status", "Scheduled", "Details"],
                ...requests.map((r) => [r.submittedDate, r.propertyName, r.unitNum, r.tenantName ?? "Office", r.title, TYPE_TEXT[r.requestType], PRIORITY_TEXT[r.priority], STATUS_TEXT[r.status], r.scheduledFor ?? "", r.description]),
              ])
            }
          >
            Export CSV
          </button>
        </div>
      </div>
      {failed && <p className="mgr-alert mgr-alert--error">{failed}</p>}
      {!data ? (
        <Loading error={error} />
      ) : requests.length === 0 ? (
        <Empty>No requests here.</Empty>
      ) : (
        <div className="mgr-requests">
          {requests.map((r) => (
            <article key={r.id} className={`mgr-card mgr-request mgr-request--${r.status}`}>
              <div className="mgr-request__main">
                <div className="mgr-request__title">
                  <h2 className="mgr-h3">{r.title}</h2>
                  <StatusPill status={r.status} />
                  {r.priority !== "none" && <span className={`mgr-pill mgr-pill--prio-${r.priority}`}>{PRIORITY_TEXT[r.priority]}</span>}
                  <span className="mgr-pill mgr-pill--vacant">{TYPE_TEXT[r.requestType]}</span>
                </div>
                <p className="mgr-muted">
                  <a
                    href={`#/units/${r.unitId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go({ name: "unit", id: r.unitId, tab: "overview" });
                    }}
                  >
                    Unit {r.unitNum} - {r.propertyName}
                  </a>{" "}
                  · {r.tenantName ? `from ${r.tenantName}` : "from the office"} · {r.submittedDate}
                  {r.scheduledFor && <> · <strong>Scheduled {isoDate(r.scheduledFor)}</strong></>}
                </p>
                {expanded && r.description && <p className="mgr-request__desc">{r.description}</p>}
                {expanded && (
                  <div className="mgr-request__edit">
                    <label>
                      Stage
                      <select value={r.status} disabled={busy === r.id} onChange={(e) => void update(r, { status: e.target.value as RequestStatus }, `Moved to ${STATUS_TEXT[e.target.value as RequestStatus]}.`)}>
                        {REQUEST_STATUSES.map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Priority
                      <select value={r.priority} disabled={busy === r.id} onChange={(e) => void update(r, { priority: e.target.value as MaintenanceRow["priority"] }, "Priority updated.")}>
                        {REQUEST_PRIORITIES.map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Type
                      <select value={r.requestType} disabled={busy === r.id} onChange={(e) => void update(r, { requestType: e.target.value as MaintenanceRow["requestType"] }, "Request type updated.")}>
                        {REQUEST_TYPES.map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Scheduled for
                      <input
                        type="date"
                        value={r.scheduledFor ?? ""}
                        disabled={busy === r.id}
                        onChange={(e) =>
                          void update(
                            r,
                            e.target.value ? { scheduledFor: e.target.value, ...(r.status === "submitted" || r.status === "in_review" ? { status: "scheduled" as const } : {}) } : { scheduledFor: null },
                            e.target.value ? `Scheduled for ${isoDate(e.target.value)}.` : "Schedule cleared.",
                          )
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
              <div className="mgr-row-actions">
                {NEXT_STATUS[r.status].map(([status, label], i) => (
                  <button
                    key={status}
                    type="button"
                    className={`mgr-btn mgr-btn--small ${i === 0 ? "mgr-btn--secondary" : "mgr-btn--ghost"}`}
                    disabled={busy === r.id}
                    onClick={() => void update(r, { status }, status === "resolved" ? "Request completed. The resident sees the update." : `Moved to ${STATUS_TEXT[status]}.`)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className="mgr-btn mgr-btn--small mgr-btn--danger-ghost"
                  disabled={busy === r.id}
                  onClick={() =>
                    open({
                      kind: "confirm",
                      title: "Delete request",
                      body: `Delete "${r.title}" (Unit ${r.unitNum})? The resident no longer sees it either.`,
                      confirmLabel: "Delete request",
                      run: () => managerApi.deleteMaintenance(r.id),
                      done: "Request deleted.",
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Updates (overdue rent, new requests, residents who have not signed up)
 * ------------------------------------------------------------------ */

const UPDATE_LABEL: Record<UpdateRow["kind"], string> = {
  overdue: "Overdue rent",
  maintenance_new: "New maintenance",
  not_signed_up: "Not signed up",
  payment_reported: "Payment to confirm",
};

function UpdateList({ updates, compact = false }: { updates: UpdateRow[]; compact?: boolean }) {
  const { go, open, can } = useManager();
  if (updates.length === 0) return <Empty>All clear. Nothing needs a decision right now.</Empty>;
  return (
    <ul className={`mgr-updates${compact ? " mgr-updates--compact" : ""}`}>
      {updates.map((u, i) => (
        <li key={i} className={`mgr-update mgr-update--${u.kind}`}>
          <div className="mgr-update__body">
            <span className="mgr-update__kind">{UPDATE_LABEL[u.kind]}</span>
            <strong>{u.title}</strong>
            <span className="mgr-muted">
              {u.unitLabel} · {u.detail}
            </span>
          </div>
          <div className="mgr-row-actions">
            {u.kind === "overdue" && u.leaseId !== null && can("ledger:adjust") && !compact && (
              <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "payment", leaseId: u.leaseId! })}>
                Record payment
              </button>
            )}
            {u.kind === "payment_reported" && can("ledger:adjust") && (
              <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "finance", period: "this-month" })}>
                Review
              </button>
            )}
            {u.kind === "maintenance_new" ? (
              <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "maintenance" })}>
                Open queue
              </button>
            ) : (
              u.leaseId !== null && (
                <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "lease", id: u.leaseId! })}>
                  Open lease
                </button>
              )
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function UpdatesPage() {
  const { data, error } = useLoad(() => managerApi.updates());
  const [kind, setKind] = useState<UpdateRow["kind"] | "all">("all");
  const rows = (data ?? []).filter((u) => kind === "all" || u.kind === kind);
  const count = (k: UpdateRow["kind"] | "all") => (data ?? []).filter((u) => k === "all" || u.kind === k).length;
  const tabs: Array<[UpdateRow["kind"] | "all", string]> = [
    ["all", "All"],
    ["payment_reported", "Payments to confirm"],
    ["overdue", "Overdue rent"],
    ["maintenance_new", "New maintenance"],
    ["not_signed_up", "Not signed up"],
  ];
  return (
    <>
      <PageHeader title="Updates" subtitle="What needs attention, biggest problems first." />
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="Filter updates">
          {tabs.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} className={`mgr-tab${kind === value ? " mgr-tab--active" : ""}`} onClick={() => setKind(value)}>
              {label} <span className="mgr-tab__count">{count(value)}</span>
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <section className="mgr-card">
          <UpdateList updates={rows} />
        </section>
      )}
    </>
  );
}

