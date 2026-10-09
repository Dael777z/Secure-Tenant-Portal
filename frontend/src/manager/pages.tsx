// The manager screens: Dashboard, Properties (+ detail), Rent Roll, Tenants,
// Lease, Maintenance and Updates. Ported from the resident-portal reference
// views (manager-dashboard, -portfolio, -rentroll, -directory, -maintenance,
// -exceptions), cut down to what the team's schema stores.
import { useMemo, useState } from "react";
import { managerApi, receiptUrl, type RequestStatus, type UnitRow, type UpdateRow } from "./api";
import type { LedgerEntry } from "../types";
import { Empty, Kpi, Loading, PageHeader, StatusPill, isoDate, money, percent, timeAgo, useLoad, useManager } from "./ui";

/* ------------------------------------------------------------------ *
 * Quick actions — the common jobs, one click from any screen
 * ------------------------------------------------------------------ */

export function QuickActions() {
  const { open, can } = useManager();
  const actions: Array<[string, () => void, boolean]> = [
    ["+ New lease", () => open({ kind: "lease" }), can("users:provision")],
    ["+ Add property", () => open({ kind: "property" }), can("users:provision")],
    ["+ Add unit", () => open({ kind: "unit" }), can("users:provision")],
    ["Record a payment", () => open({ kind: "payment" }), can("ledger:adjust")],
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
  if (units.length === 0) return <Empty>No units match.</Empty>;
  return (
    <div className="mgr-table-wrap">
      <table className="mgr-table">
        <thead>
          <tr>
            <th scope="col">Unit</th>
            {showProperty && <th scope="col">Property</th>}
            <th scope="col">Residents</th>
            <th scope="col" className="mgr-num">Rent</th>
            <th scope="col" className="mgr-num">Balance</th>
            <th scope="col">Status</th>
            <th scope="col">Lease</th>
            <th scope="col"><span className="mgr-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.id}>
              <th scope="row">
                {u.unitNum}
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
      <PageHeader title="Rent Roll" subtitle="Every unit, who lives there, and where each account stands today." />
      <QuickActions />
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

export function TenantsPage() {
  const { go, open, can } = useManager();
  const { data, error } = useLoad(() => managerApi.tenants());
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = (data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.email.includes(q) || (t.unitLabel ?? "").toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Everyone with a resident account, and whether they have signed up yet."
        actions={
          can("users:provision") && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "tenant" })}>
              + Invite tenant
            </button>
          )
        }
      />
      <div className="mgr-toolbar">
        <input type="search" aria-label="Search tenants" placeholder="Search name, email or unit" value={search} onChange={(e) => setSearch(e.target.value)} />
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
                    <th scope="col">Name</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Unit</th>
                    <th scope="col" className="mgr-num">Balance</th>
                    <th scope="col">Account</th>
                    <th scope="col"><span className="mgr-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">{t.name}</th>
                      <td>
                        <a href={`mailto:${t.email}`}>{t.email}</a>
                        {t.phone && <div className="mgr-muted">{t.phone}</div>}
                      </td>
                      <td>{t.unitLabel ?? <span className="mgr-muted">No lease</span>}</td>
                      <td className={`mgr-num${t.balance > 0 ? " mgr-owes" : ""}`}>{t.leaseId === null ? "—" : money(t.balance)}</td>
                      <td>{t.signedUp ? <span className="mgr-pill mgr-pill--current">Signed up</span> : <span className="mgr-pill mgr-pill--submitted">Invited</span>}</td>
                      <td className="mgr-row-actions">
                        {t.leaseId !== null && (
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: t.leaseId! })}>
                            Lease
                          </button>
                        )}
                        {can("users:provision") && (
                          <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "editTenant", id: t.id, name: t.name, phone: t.phone })}>
                            Edit
                          </button>
                        )}
                        {can("users:provision") && t.leaseId === null && (
                          <button
                            type="button"
                            className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                            onClick={() =>
                              open({
                                kind: "confirm",
                                title: "Delete tenant",
                                body: `Delete ${t.name} (${t.email})? Their account and sign-in go. Payments and requests from past leases stay on record without their name.`,
                                confirmLabel: "Delete tenant",
                                run: () => managerApi.deleteTenant(t.id),
                                done: `${t.name} deleted.`,
                              })
                            }
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
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
  const hasPayments = data.ledger.some((e) => e.id.startsWith("payment-"));
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

  return (
    <>
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
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "payment", leaseId: id })}>
                Record a payment
              </button>
            )}
            {can("users:provision") && !ended && (
              <>
                <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "rent", leaseId: id, monthlyRent: data.monthlyRent })}>
                  Change rent
                </button>
                <button type="button" className="mgr-btn mgr-btn--danger-ghost" onClick={() => open({ kind: "endLease", leaseId: id, label })}>
                  End lease
                </button>
              </>
            )}
            {can("users:provision") && !hasPayments && (
              <button
                type="button"
                className="mgr-btn mgr-btn--danger-ghost"
                onClick={() =>
                  open({
                    kind: "confirm",
                    title: "Delete lease",
                    body: `Delete this lease on ${label}? Use this for a lease entered by mistake: it has no payments yet. Its residents stay in Tenants.`,
                    confirmLabel: "Delete lease",
                    run: () => managerApi.deleteLease(id),
                    done: "Lease deleted. The unit is vacant again.",
                    after: { name: "rent-roll" },
                  })
                }
              >
                Delete lease
              </button>
            )}
          </>
        }
      />
      <div className="mgr-kpis">
        <Kpi label="Balance due" value={money(data.balance)} tone={data.balance > 0 ? "warn" : "good"} note={data.balance > 0 ? "Owed today" : "Paid up"} />
        <Kpi label="Monthly rent" value={money(data.monthlyRent)} note="Charged on the 1st" />
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

const NEXT_STATUS: Record<RequestStatus, Array<[RequestStatus, string]>> = {
  submitted: [["in_progress", "Start work"], ["resolved", "Mark resolved"]],
  in_progress: [["resolved", "Mark resolved"], ["submitted", "Back to new"]],
  resolved: [["in_progress", "Reopen"]],
};

export function MaintenancePage() {
  const { open, changed } = useManager();
  const { data, error } = useLoad(() => managerApi.maintenance());
  const [filter, setFilter] = useState<"open" | RequestStatus | "all">("open");
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const requests = (data?.requests ?? []).filter((r) =>
    filter === "all" ? true : filter === "open" ? r.status !== "resolved" : r.status === filter,
  );
  const count = (f: typeof filter) =>
    (data?.requests ?? []).filter((r) => (f === "all" ? true : f === "open" ? r.status !== "resolved" : r.status === f)).length;

  async function move(id: number, status: RequestStatus) {
    setBusy(id);
    setFailed(null);
    try {
      await managerApi.setMaintenanceStatus(id, status);
      changed(status === "resolved" ? "Request resolved. The resident sees the update." : "Status updated.");
    } catch {
      setFailed("That status change did not save. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const tabs: Array<[typeof filter, string]> = [
    ["open", "Open"],
    ["submitted", "New"],
    ["in_progress", "In progress"],
    ["resolved", "Resolved"],
    ["all", "All"],
  ];

  return (
    <>
      <PageHeader
        title="Maintenance"
        subtitle="Requests from residents and the office. Status changes show up in the resident's portal."
        actions={
          <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "maintenance" })}>
            + New request
          </button>
        }
      />
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="Filter by status">
          {tabs.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={`mgr-tab${filter === value ? " mgr-tab--active" : ""}`} onClick={() => setFilter(value)}>
              {label} <span className="mgr-tab__count">{count(value)}</span>
            </button>
          ))}
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
                </div>
                <p className="mgr-muted">
                  Unit {r.unitNum} - {r.propertyName} · {r.tenantName ? `from ${r.tenantName}` : "from the office"} · {r.submittedDate}
                </p>
                {r.description && <p className="mgr-request__desc">{r.description}</p>}
              </div>
              <div className="mgr-row-actions">
                {NEXT_STATUS[r.status].map(([status, label], i) => (
                  <button
                    key={status}
                    type="button"
                    className={`mgr-btn mgr-btn--small ${i === 0 ? "mgr-btn--secondary" : "mgr-btn--ghost"}`}
                    disabled={busy === r.id}
                    onClick={() => void move(r.id, status)}
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

