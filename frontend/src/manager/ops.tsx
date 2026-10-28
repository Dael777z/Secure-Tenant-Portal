// RentRedi-style management screens (migration 008): Rent & Charges, Payments
// & Returns, Payment Rules (late fees, reminders, payment order), the unit and
// tenant pages with their tabs, Documents, Settings, and their dialogs.
// Every number comes from the API; the browser only filters and sorts.
import { useMemo, useState, type ReactNode } from "react";
import { managerApi, readReceipt, receiptUrl, RECEIPT_MAX_BYTES, type ReceiptUpload, type TenantRow, type UnitRow } from "./api";
import { downloadCsv, financeApi, type FinancePeriod, type RecentPaymentRow } from "./finance-api";
import { PaymentOptionsPage, ReportedPayments } from "./finance";
import {
  CHARGE_KINDS,
  MAX_REPEATS,
  addMonths,
  feeFor,
  lateFeeSchedule,
  leaseDocumentUrl,
  monthLabel,
  monthRange,
  opsApi,
  type ChargeKind,
  type ChargeRow,
  type FeeType,
  type LateFeeRule,
  type NewLateFeeRule,
  type UnitRule,
} from "./ops-api";
import { SortTh, useSort } from "./sort";
import {
  Breadcrumbs,
  Empty,
  Field,
  Kpi,
  Loading,
  LocalError,
  Modal,
  PageHeader,
  PageTabs,
  StatusPill,
  ViewCard,
  isoDate,
  money,
  percent,
  timeAgo,
  todayIso,
  useLoad,
  useManager,
  useSubmit,
  type Dialog,
  type PaymentView,
  type RulesTab,
  type SettingsTab,
  type TenantTab,
  type UnitTab,
} from "./ui";

type DialogProps<K extends Dialog["kind"]> = Extract<Dialog, { kind: K }> & { onClose: () => void };

const ALL_FROM = "2000-01-01";
const ALL_TO = "2099-12-31";
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
const SOURCE_LABEL: Record<NonNullable<ChargeRow["source"]>, string> = { manual: "Office (manual)", online: "Tenant (online)", both: "Office + online" };

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="mgr-alert mgr-alert--error" role="alert">
      {error}
    </p>
  ) : null;
}

function Actions({ busy, label, onClose, loading, disabled }: { busy: boolean; label: string; onClose: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <div className="mgr-modal__actions">
      <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy || loading || disabled}>
        {busy ? "Saving…" : label}
      </button>
    </div>
  );
}

function parseMoney(value: string, what: string): number {
  const n = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new LocalError(`Enter ${what} as a number, like 25.00.`);
  if (Math.round(n * 100) !== n * 100) throw new LocalError(`Enter ${what} in dollars and cents, like 25.50.`);
  return n;
}

const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A small "More" menu (export, print) on a card. */
export function MoreMenu({ items, label = "More" }: { items: Array<[string, () => void]>; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mgr-more">
      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && (
        <ul className="mgr-more__menu" role="menu">
          {items.map(([label, run]) => (
            <li key={label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  run();
                }}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rent & Charges
 * ------------------------------------------------------------------ */

type ChargeView = "all" | "paid" | "due" | "late";

function recentMonths(today: string): string[] {
  const out: string[] = [];
  for (let n = -4; n <= 1; n++) out.push(addMonths(`${today.slice(0, 7)}-01`, n).slice(0, 7));
  return out;
}

export function RentChargesPage({ month }: { month: string }) {
  const { go, open, can } = useManager();
  const today = todayIso();
  const range = month === "all" ? { from: ALL_FROM, to: ALL_TO } : monthRange(`${month}-01`);
  const { data, error } = useLoad(() => opsApi.charges(range.from, range.to), [range.from, range.to]);
  const properties = useLoad(() => managerApi.properties());
  const [view, setView] = useState<ChargeView>("all");
  const [property, setProperty] = useState("");
  const [source, setSource] = useState<"" | "manual" | "online" | "none">("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (r) =>
        (view === "all" || r.status === view) &&
        (!property || String(r.propertyId) === property) &&
        (!kind || r.kind === kind) &&
        (!source || (source === "none" ? r.source === null : r.source === source || r.source === "both")) &&
        (!q || r.unitNum.toLowerCase().includes(q) || r.tenants.some((t) => t.name.toLowerCase().includes(q)) || r.description.toLowerCase().includes(q)),
    );
  }, [data, view, property, kind, source, search]);
  const sorter = useSort("rent-charges", rows, {
    due: (r) => r.dueDate,
    unit: (r) => `${r.propertyName} ${r.unitNum}`,
    tenant: (r) => r.tenants[0]?.name ?? null,
    charge: (r) => r.kindLabel,
    amount: (r) => r.amount,
    unpaid: (r) => r.unpaid,
    status: (r) => ({ late: 0, due: 1, paid: 2 })[r.status],
  }, { key: "due", dir: "asc" });
  const filtered = view !== "all" || property || kind || source || search;
  const kinds = [...new Set((data?.rows ?? []).map((r) => r.kind))];

  function exportCsv() {
    downloadCsv(`rent-and-charges-${month}.csv`, [
      ["Due date", "Property", "Unit", "Tenants", "Charge", "Description", "Amount", "Paid", "Unpaid", "Status", "Paid by", "Paid on"],
      ...sorter.rows.map((r) => [r.dueDate, r.propertyName, r.unitNum, r.tenants.map((t) => t.name).join("; "), r.kindLabel, r.description, r.amount, r.paid, r.unpaid, r.status, r.source ? SOURCE_LABEL[r.source] : "", r.paidOn ?? ""]),
    ]);
  }

  return (
    <>
      <PageHeader
        title="Rent & Charges"
        subtitle="Every charge due, what has been paid, and what is late. Rent is billed automatically on each lease's start day."
        actions={
          <>
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => go({ name: "payments", period: "this-month" })}>
              View payments
            </button>
            {can("ledger:adjust") && (
              <>
                <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => open({ kind: "payment" })}>
                  Record a payment
                </button>
                <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "charge" })}>
                  + Add charge
                </button>
              </>
            )}
          </>
        }
      />
      <nav className="mgr-months" aria-label="Month">
        <a
          href="#/rent-and-charges?month=all"
          className={`mgr-month${month === "all" ? " mgr-month--active" : ""}`}
          aria-current={month === "all" ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            go({ name: "charges", month: "all" });
          }}
        >
          All time
        </a>
        {recentMonths(today).map((m) => (
          <a
            key={m}
            href={`#/rent-and-charges?month=${m}`}
            className={`mgr-month${month === m ? " mgr-month--active" : ""}`}
            aria-current={month === m ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              go({ name: "charges", month: m });
            }}
          >
            {monthLabel(`${m}-01`)}
            {m === today.slice(0, 7) && <span className="mgr-month__now">This month</span>}
          </a>
        ))}
        <label className="mgr-month mgr-month--pick">
          <span className="mgr-sr">Other month</span>
          <input
            type="month"
            value={month === "all" ? "" : month}
            onChange={(e) => e.target.value && go({ name: "charges", month: e.target.value })}
          />
        </label>
      </nav>
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          {data.allTimeLate > 0 && (
            <div className="mgr-banner mgr-banner--warn" role="status">
              <span>
                <strong>{money(data.allTimeLate)}</strong> is late across all months.
              </span>
              <button
                type="button"
                className="mgr-btn mgr-btn--secondary mgr-btn--small"
                onClick={() => {
                  setView("late");
                  if (month !== "all") go({ name: "charges", month: "all" });
                }}
              >
                Show late charges
              </button>
            </div>
          )}
          <div className="mgr-viewcards">
            <ViewCard label="Charged" value={money(data.summary.charged)} note={`${data.rows.length} charge${data.rows.length === 1 ? "" : "s"} · view all`} active={view === "all"} onClick={() => setView("all")} />
            <ViewCard label="Paid" value={money(data.summary.paid)} active={view === "paid"} onClick={() => setView("paid")} tone="good" />
            <ViewCard label="Due" value={money(data.summary.due)} note="Not late yet · view due" active={view === "due"} onClick={() => setView("due")} />
            <ViewCard label="Late" value={money(data.summary.late)} active={view === "late"} onClick={() => setView("late")} tone={data.summary.late > 0 ? "warn" : undefined} />
          </div>
          <div className="mgr-collect" aria-label={`${percent(data.summary.paid, data.summary.charged)} collected`}>
            <div className="mgr-collect__bar" role="img" aria-hidden="true">
              <span className="mgr-collect__paid" style={{ width: percent(data.summary.paid, data.summary.charged) }} />
              <span className="mgr-collect__late" style={{ width: percent(data.summary.late, data.summary.charged) }} />
            </div>
            <span className="mgr-muted">
              {percent(data.summary.paid, data.summary.charged)} collected · {isoDate(data.from)} – {isoDate(data.to)}
            </span>
          </div>
          <div className="mgr-toolbar">
            <div className="mgr-toolbar__filters">
              <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}>
                <option value="">All properties</option>
                {(properties.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select aria-label="Charge type" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All charge types</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {data.rows.find((r) => r.kind === k)?.kindLabel ?? k}
                  </option>
                ))}
              </select>
              <select aria-label="Payment source" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                <option value="">All payment sources</option>
                <option value="online">Paid online by tenant</option>
                <option value="manual">Recorded by the office</option>
                <option value="none">Not paid yet</option>
              </select>
              <input type="search" aria-label="Search unit, tenant or charge" placeholder="Search unit, tenant or charge" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="mgr-toolbar__filters">
              {filtered && (
                <button
                  type="button"
                  className="mgr-btn mgr-btn--ghost mgr-btn--small"
                  onClick={() => {
                    setView("all");
                    setProperty("");
                    setKind("");
                    setSource("");
                    setSearch("");
                  }}
                >
                  Clear filters
                </button>
              )}
              <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={exportCsv} disabled={rows.length === 0}>
                Export CSV
              </button>
            </div>
          </div>
          <section className="mgr-card">
            {rows.length === 0 ? (
              <Empty>{data.rows.length === 0 ? "No charges are due in this period." : "No charges match these filters."}</Empty>
            ) : (
              <div className="mgr-table-wrap">
                <table className="mgr-table">
                  <thead>
                    <tr>
                      <SortTh sorter={sorter} k="due">Due</SortTh>
                      <SortTh sorter={sorter} k="unit">Unit</SortTh>
                      <SortTh sorter={sorter} k="tenant">Tenant</SortTh>
                      <SortTh sorter={sorter} k="charge">Charge</SortTh>
                      <SortTh sorter={sorter} k="amount" num>Amount</SortTh>
                      <SortTh sorter={sorter} k="unpaid" num>Unpaid</SortTh>
                      <SortTh sorter={sorter} k="status">Status</SortTh>
                      <th scope="col"><span className="mgr-sr">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorter.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{isoDate(r.dueDate)}</td>
                        <th scope="row">
                          <a
                            href={`#/units/${r.unitId}`}
                            onClick={(e) => {
                              e.preventDefault();
                              go({ name: "unit", id: r.unitId, tab: "charges" });
                            }}
                          >
                            Unit {r.unitNum}
                          </a>
                          <div className="mgr-muted">{r.propertyName}</div>
                        </th>
                        <td>{r.tenants.length ? r.tenants.map((t) => t.name).join(", ") : <span className="mgr-muted">—</span>}</td>
                        <td>
                          {r.kindLabel === r.description ? r.kindLabel : <>{r.kindLabel}<div className="mgr-muted">{r.description}</div></>}
                        </td>
                        <td className="mgr-num">{money(r.amount)}</td>
                        <td className={`mgr-num${r.unpaid > 0 ? " mgr-owes" : ""}`}>{money(r.unpaid)}</td>
                        <td>
                          <StatusPill status={r.status} />
                          <div className="mgr-muted">{r.source ? SOURCE_LABEL[r.source] : r.status === "paid" ? "" : "Not paid"}{r.paidOn ? ` · ${isoDate(r.paidOn)}` : ""}</div>
                        </td>
                        <td className="mgr-row-actions">
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: r.leaseId })}>
                            Lease
                          </button>
                          {r.unpaid > 0 && can("ledger:adjust") && (
                            <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "payment", leaseId: r.leaseId })}>
                              Record payment
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mgr-table-foot">
              {rows.length} charge{rows.length === 1 ? "" : "s"} · {money(rows.reduce((s, r) => s + r.amount, 0))} charged ·{" "}
              <span className={rows.some((r) => r.unpaid > 0) ? "mgr-owes" : undefined}>{money(rows.reduce((s, r) => s + r.unpaid, 0))} unpaid</span>
            </p>
          </section>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Payments & Returns
 * ------------------------------------------------------------------ */

const PAYMENT_VIEW_STATUS: Record<PaymentView, RecentPaymentRow["status"]> = { paid: "paid", partial: "partial", ahead: "prepaid", returns: "refund" };
const PAYMENT_PERIODS: Array<[FinancePeriod, string]> = [
  ["this-month", "This month"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["ytd", "This year"],
  ["12m", "Last 12 months"],
];

export function PaymentsPage({ period, view }: { period: FinancePeriod; view?: PaymentView }) {
  const { go, open, can } = useManager();
  const { data, error } = useLoad(() => financeApi.overview(period), [period]);
  const [search, setSearch] = useState("");
  const all = data?.recentPayments ?? [];
  const count = (v: PaymentView) => all.filter((p) => p.status === PAYMENT_VIEW_STATUS[v]).length;
  const sum = (v?: PaymentView) => all.filter((p) => !v || p.status === PAYMENT_VIEW_STATUS[v]).reduce((s, p) => s + p.amount, 0);
  const q = search.trim().toLowerCase();
  const rows = all.filter((p) => (!view || p.status === PAYMENT_VIEW_STATUS[view]) && (!q || p.payer.toLowerCase().includes(q) || p.unitLabel.toLowerCase().includes(q) || p.confirmation.toLowerCase().includes(q)));
  const setView = (v?: PaymentView) => go({ name: "payments", period, view: v === view ? undefined : v });

  return (
    <>
      <PageHeader
        title="Payments & Returns"
        subtitle="Money tenants paid online, payments the office recorded, money paid ahead and refunds."
        actions={
          <>
            <label className="mgr-period">
              <span className="mgr-sr">Period</span>
              <select value={period} onChange={(e) => go({ name: "payments", period: e.target.value as FinancePeriod, view })}>
                {PAYMENT_PERIODS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {can("ledger:adjust") && (
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "payment" })}>
                Record a payment
              </button>
            )}
          </>
        }
      />
      <ReportedPayments />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mgr-viewcards">
            <ViewCard label="All payments" value={money(sum())} note={`${all.length} payment${all.length === 1 ? "" : "s"} · view all`} active={!view} onClick={() => setView(undefined)} />
            <ViewCard label="Paid in full" value={money(sum("paid"))} note={`${count("paid")} · view paid`} active={view === "paid"} onClick={() => setView("paid")} tone="good" />
            <ViewCard label="Partial" value={money(sum("partial"))} note={`${count("partial")} · view partial`} active={view === "partial"} onClick={() => setView("partial")} />
            <ViewCard label="Paid ahead" value={money(sum("ahead"))} note={`${count("ahead")} · view paid ahead`} active={view === "ahead"} onClick={() => setView("ahead")} />
            <ViewCard label="Returns" value={money(sum("returns"))} note={`${count("returns")} refund${count("returns") === 1 ? "" : "s"} · view returns`} active={view === "returns"} onClick={() => setView("returns")} tone={count("returns") ? "warn" : undefined} />
          </div>
          <div className="mgr-toolbar">
            <input type="search" aria-label="Search payer, unit or confirmation" placeholder="Search payer, unit or confirmation" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button
              type="button"
              className="mgr-btn mgr-btn--secondary mgr-btn--small"
              disabled={rows.length === 0}
              onClick={() =>
                downloadCsv(`payments-${period}.csv`, [
                  ["Paid", "Payer", "Unit", "Property", "Amount", "Method", "Confirmation", "Status", "Paid ahead"],
                  ...rows.map((p) => [p.paidAt.slice(0, 10), p.payer, p.unitLabel, p.propertyName, p.amount, p.method ?? "", p.confirmation, p.status, p.ahead]),
                ])
              }
            >
              Export CSV
            </button>
          </div>
          <section className="mgr-card">
            {rows.length === 0 ? (
              <Empty>No payments match.</Empty>
            ) : (
              <div className="mgr-table-wrap">
                <table className="mgr-table">
                  <thead>
                    <tr>
                      <th scope="col">Paid</th>
                      <th scope="col">Payer</th>
                      <th scope="col">Unit</th>
                      <th scope="col" className="mgr-num">Amount</th>
                      <th scope="col">Method</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className="mgr-sr">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {isoDate(p.paidAt.slice(0, 10))}
                          <div className="mgr-muted mgr-mono">{p.confirmation}</div>
                        </td>
                        <th scope="row">{p.payer}</th>
                        <td>
                          {p.unitLabel}
                          <div className="mgr-muted">{p.propertyName}</div>
                        </td>
                        <td className={`mgr-num${p.amount < 0 ? " mgr-owes" : ""}`}>{money(p.amount)}</td>
                        <td className="mgr-muted">{p.method ?? (p.confirmation.startsWith("OFF-") ? "Office" : "Online")}</td>
                        <td>
                          <span className={`mgr-pill mgr-pill--${p.status}`}>{{ paid: "Paid", partial: "Partial", prepaid: "Paid ahead", refund: "Refund" }[p.status]}</span>
                          {p.ahead > 0 && <div className="mgr-muted">{money(p.ahead)} held as credit</div>}
                        </td>
                        <td className="mgr-row-actions">
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: p.leaseId })}>
                            Lease
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Payment Rules: late fees, rent reminders, payment order
 * ------------------------------------------------------------------ */

const RULE_TABS: ReadonlyArray<readonly [RulesTab, string]> = [
  ["late-fees", "Late fees"],
  ["reminders", "Rent reminders"],
  ["order", "Payment order"],
];

const feeText = (amount: number, type: FeeType) => (type === "percent" ? `${amount}% of rent` : money(amount));
const SOURCE_TEXT: Record<NonNullable<UnitRule["source"]>, string> = { unit: "This unit's own rule", property: "The property's rule", all: "The rule for all properties" };

export function describeLateFee(r: Pick<NewLateFeeRule, "graceDays" | "firstAmount" | "firstType" | "dailyAmount" | "dailyType" | "maxAmount" | "maxType">): string {
  const parts: string[] = [];
  if (r.firstAmount > 0) parts.push(`${feeText(r.firstAmount, r.firstType)} once rent is ${r.graceDays} day${r.graceDays === 1 ? "" : "s"} late`);
  if (r.dailyAmount > 0) parts.push(`then ${feeText(r.dailyAmount, r.dailyType)} a day`);
  parts.push(r.maxAmount === null ? "no limit" : `at most ${feeText(r.maxAmount, r.maxType)} in all`);
  return parts.join(", ");
}

function UnitCoverage({ units, ruleLabel }: { units: UnitRule[]; ruleLabel: (u: UnitRule) => ReactNode }) {
  const sorter = useSort("rule-units", units, { property: (u) => u.propertyName, unit: (u) => u.unitNum, source: (u) => u.source }, { key: "property", dir: "asc" });
  if (units.length === 0) return <Empty>No units yet.</Empty>;
  return (
    <div className="mgr-table-wrap">
      <table className="mgr-table mgr-table--compact">
        <thead>
          <tr>
            <SortTh sorter={sorter} k="property">Property</SortTh>
            <SortTh sorter={sorter} k="unit">Unit</SortTh>
            <SortTh sorter={sorter} k="source">Rule that applies</SortTh>
          </tr>
        </thead>
        <tbody>
          {sorter.rows.map((u) => (
            <tr key={u.unitId}>
              <td>{u.propertyName}</td>
              <th scope="row">Unit {u.unitNum}</th>
              <td>{u.ruleId === null ? <span className="mgr-muted">None</span> : <>{ruleLabel(u)}<div className="mgr-muted">{SOURCE_TEXT[u.source!]}</div></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LateFeeRules() {
  const { open, can } = useManager();
  const { data, error } = useLoad(() => opsApi.lateFeeRules());
  if (!data) return <Loading error={error} />;
  const byId = new Map(data.rules.map((r) => [r.id, r]));
  const sample = data.rules[0];
  return (
    <>
      <section className="mgr-card">
        <div className="mgr-card__head">
          <h2 className="mgr-h2">Late fee rules</h2>
          {can("ledger:adjust") && (
            <button type="button" className="mgr-btn mgr-btn--primary mgr-btn--small" onClick={() => open({ kind: "lateFeeRule" })}>
              + Add rule
            </button>
          )}
        </div>
        <p className="mgr-muted">
          Late fees are added to the tenant's ledger automatically each morning while rent stays unpaid. A unit's own rule wins over its property's, and a property's over the rule for all properties.
        </p>
        {data.rules.length === 0 ? (
          <Empty>No late fee rules. Rent that is paid late gets no fee until you add one.</Empty>
        ) : (
          <div className="mgr-table-wrap">
            <table className="mgr-table">
              <thead>
                <tr>
                  <th scope="col">Applies to</th>
                  <th scope="col">Grace</th>
                  <th scope="col">First fee</th>
                  <th scope="col">Daily fee</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Added</th>
                  <th scope="col"><span className="mgr-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.label}</th>
                    <td>{r.graceDays} day{r.graceDays === 1 ? "" : "s"}</td>
                    <td>{r.firstAmount > 0 ? feeText(r.firstAmount, r.firstType) : "—"}</td>
                    <td>{r.dailyAmount > 0 ? feeText(r.dailyAmount, r.dailyType) : "—"}</td>
                    <td>{r.maxAmount === null ? "No limit" : feeText(r.maxAmount, r.maxType)}</td>
                    <td className="mgr-muted">
                      {timeAgo(r.createdAt)}
                      {r.createdBy && <div>{r.createdBy}</div>}
                    </td>
                    <td className="mgr-row-actions">
                      {can("ledger:adjust") && (
                        <>
                          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "lateFeeRule", propertyId: r.propertyId ?? undefined, unitId: r.unitId ?? undefined })}>
                            Change
                          </button>
                          <button
                            type="button"
                            className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                            onClick={() =>
                              open({
                                kind: "confirm",
                                title: "Turn off late fee rule",
                                body: `Stop adding late fees for ${r.label}? Fees already charged stay on the ledger. The rule stays on record.`,
                                confirmLabel: "Turn off",
                                run: () => opsApi.retireLateFeeRule(r.id),
                                done: "Late fee rule turned off.",
                              })
                            }
                          >
                            Turn off
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {sample && <FeePreview rule={sample} title={`Example: ${sample.label}`} />}
      <section className="mgr-card">
        <h2 className="mgr-h2">Units</h2>
        <UnitCoverage units={data.units} ruleLabel={(u) => describeLateFee(byId.get(u.ruleId!)!)} />
      </section>
    </>
  );
}

/** What a rule charges a rent bill day by day (the same rule the nightly job uses). */
function FeePreview({ rule, title, rent: initialRent = 1000 }: { rule: Pick<LateFeeRule, "graceDays" | "firstAmount" | "firstType" | "dailyAmount" | "dailyType" | "maxAmount" | "maxType">; title: string; rent?: number }) {
  const [rent, setRent] = useState(String(initialRent));
  const r = Number(rent) > 0 ? Number(rent) : initialRent;
  const days = Math.min(45, Math.max(10, rule.graceDays + 10));
  const schedule = lateFeeSchedule(rule, r, days).filter((d) => d.fee > 0);
  const total = schedule.at(-1)?.total ?? 0;
  return (
    <section className="mgr-card mgr-preview" aria-label="Late fee preview">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">{title}</h2>
        <label className="mgr-inline-field">
          Rent
          <input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} aria-label="Rent for the example" />
        </label>
      </div>
      {schedule.length === 0 ? (
        <Empty>This rule adds no fee in the first {days} days.</Empty>
      ) : (
        <ol className="mgr-preview__days">
          {schedule.slice(0, 8).map((d) => (
            <li key={d.daysLate}>
              <strong>Day {d.daysLate} late</strong>
              <span>+{money(d.fee)}</span>
              <span className="mgr-muted">{money(d.total)} so far</span>
            </li>
          ))}
          {schedule.length > 8 && (
            <li className="mgr-muted">
              … {money(total)} by day {days}
              {rule.maxAmount !== null && total >= feeFor(rule.maxAmount, rule.maxType, r) ? " (the limit)" : ""}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function ReminderRules() {
  const { open, can } = useManager();
  const { data, error } = useLoad(() => opsApi.reminderRules());
  if (!data) return <Loading error={error} />;
  const byId = new Map(data.rules.map((r) => [r.id, r]));
  const say = (r: { daysBefore: number; repeatAfterDue: boolean }) =>
    `${r.daysBefore === 0 ? "On the due day" : `${r.daysBefore} day${r.daysBefore === 1 ? "" : "s"} before it is due`}${r.repeatAfterDue ? ", then every day while late" : ""}`;
  return (
    <>
      <section className="mgr-card">
        <div className="mgr-card__head">
          <h2 className="mgr-h2">Rent reminders</h2>
          {can("ledger:adjust") && (
            <button type="button" className="mgr-btn mgr-btn--primary mgr-btn--small" onClick={() => open({ kind: "reminderRule" })}>
              + Add rule
            </button>
          )}
        </div>
        <p className="mgr-muted">Tenants get a reminder in their portal before rent is due, on the due day and, if you choose, every day while it is late.</p>
        {data.rules.length === 0 ? (
          <Empty>No reminder rules. Tenants only see their balance when they sign in.</Empty>
        ) : (
          <ul className="mgr-rule-list">
            {data.rules.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.label}</strong>
                  <span className="mgr-muted">{say(r)}</span>
                </div>
                {can("ledger:adjust") && (
                  <div className="mgr-row-actions">
                    <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "reminderRule", propertyId: r.propertyId ?? undefined, unitId: r.unitId ?? undefined })}>
                      Change
                    </button>
                    <button
                      type="button"
                      className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                      onClick={() =>
                        open({
                          kind: "confirm",
                          title: "Turn off reminders",
                          body: `Stop sending rent reminders for ${r.label}?`,
                          confirmLabel: "Turn off",
                          run: () => opsApi.retireReminderRule(r.id),
                          done: "Reminders turned off.",
                        })
                      }
                    >
                      Turn off
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="mgr-card">
        <h2 className="mgr-h2">Reminders sent</h2>
        {data.sent.length === 0 ? (
          <Empty>No reminders have gone out yet.</Empty>
        ) : (
          <div className="mgr-table-wrap">
            <table className="mgr-table mgr-table--compact">
              <thead>
                <tr>
                  <th scope="col">Sent</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Tenants</th>
                  <th scope="col">Reminder</th>
                  <th scope="col" className="mgr-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.sent.slice(0, 30).map((s) => (
                  <tr key={`${s.chargeId}-${s.kind}-${s.sentOn}`}>
                    <td>{isoDate(s.sentOn)}</td>
                    <th scope="row">{s.unitLabel}</th>
                    <td>{s.tenants.join(", ") || "—"}</td>
                    <td>
                      {{ upcoming: "Coming up", due: "Due today", overdue: "Overdue" }[s.kind]}
                      <div className="mgr-muted">Due {isoDate(s.dueDate)}</div>
                    </td>
                    <td className="mgr-num">{money(s.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="mgr-card">
        <h2 className="mgr-h2">Units</h2>
        <UnitCoverage units={data.units} ruleLabel={(u) => say(byId.get(u.ruleId!)!)} />
      </section>
    </>
  );
}

function PaymentOrder() {
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Payment order</h2>
      <p>Every payment pays the oldest unpaid charge first, then the next oldest, for every unit.</p>
      <ul className="mgr-checks">
        <li>A late fee from last month is paid before this month's rent.</li>
        <li>Tenants pay their whole balance when they pay online, so nothing old is left behind.</li>
        <li>Money paid beyond the balance is held as credit and pays the next charges as they come due.</li>
      </ul>
      <p className="mgr-muted">This is the same for every property, so a ledger always reads the same way to the tenant and the office.</p>
    </section>
  );
}

export function PaymentRulesPage({ tab }: { tab: RulesTab }) {
  return (
    <>
      <PageHeader title="Payment Rules" subtitle="Late fees, rent reminders and how payments are applied." />
      <PageTabs label="Payment rules" tabs={RULE_TABS} active={tab} href={(t) => ({ name: "payment-rules", tab: t })} />
      {tab === "late-fees" && <LateFeeRules />}
      {tab === "reminders" && <ReminderRules />}
      {tab === "order" && <PaymentOrder />}
    </>
  );
}

/* ---------- Scope picker shared by the rule dialogs ---------- */

function useScope(propertyId?: number, unitId?: number) {
  const properties = useLoad(() => managerApi.properties());
  const units = useLoad(() => managerApi.units());
  const [property, setProperty] = useState(propertyId ? String(propertyId) : "");
  const [unit, setUnit] = useState(unitId ? String(unitId) : "");
  const field = (
    <div className="mgr-form__row">
      <Field label="Applies to">
        <select
          value={property}
          onChange={(e) => {
            setProperty(e.target.value);
            setUnit("");
          }}
        >
          <option value="">All properties</option>
          {(properties.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Unit" hint={property ? "Leave on “Every unit” for the whole property." : "Pick a property first to set one unit."}>
        <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!property}>
          <option value="">Every unit</option>
          {(units.data ?? [])
            .filter((u) => String(u.propertyId) === property)
            .map((u) => (
              <option key={u.id} value={u.id}>
                Unit {u.unitNum}
              </option>
            ))}
        </select>
      </Field>
    </div>
  );
  const scope = { propertyId: property ? Number(property) : null, unitId: unit ? Number(unit) : null };
  const rentOf = () => {
    const list = (units.data ?? []).filter((u) => (scope.unitId ? u.id === scope.unitId : scope.propertyId ? u.propertyId === scope.propertyId : true));
    const rents = list.map((u) => u.monthlyRent).filter((r): r is number => r !== null);
    return rents.length ? Math.round(rents.reduce((s, r) => s + r, 0) / rents.length) : 1000;
  };
  return { field, scope, loading: !properties.data || !units.data, rentOf };
}

export function LateFeeRuleDialog({ propertyId, unitId, onClose }: DialogProps<"lateFeeRule">) {
  const { changed } = useManager();
  const existing = useLoad(() => opsApi.lateFeeRules());
  const { field, scope, loading, rentOf } = useScope(propertyId, unitId);
  const current = existing.data?.rules.find((r) => r.propertyId === scope.propertyId && r.unitId === scope.unitId);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const base = {
    grace: String(current?.graceDays ?? 5),
    first: String(current?.firstAmount ?? 50),
    firstType: current?.firstType ?? "flat",
    daily: String(current?.dailyAmount ?? 0),
    dailyType: current?.dailyType ?? "flat",
    max: current?.maxAmount === null || current === undefined ? (current ? "" : "100") : String(current.maxAmount),
    maxType: current?.maxType ?? "flat",
  };
  const f = { ...base, ...form };
  const set = (k: keyof typeof base, v: string) => setForm({ ...f, [k]: v });
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(/[$,%\s]/g, "")));
  const draft: NewLateFeeRule = {
    ...scope,
    graceDays: Math.max(0, Math.floor(num(f.grace))),
    firstAmount: num(f.first),
    firstType: f.firstType as FeeType,
    dailyAmount: num(f.daily),
    dailyType: f.dailyType as FeeType,
    maxAmount: f.max.trim() === "" ? null : num(f.max),
    maxType: f.maxType as FeeType,
  };
  const valid = [draft.graceDays, draft.firstAmount, draft.dailyAmount, draft.maxAmount ?? 0].every((n) => Number.isFinite(n) && n >= 0);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Late fee rule saved. It applies from tomorrow morning.");
  });
  const typeSelect = (k: "firstType" | "dailyType" | "maxType", label: string) => (
    <select aria-label={label} value={f[k]} onChange={(e) => set(k, e.target.value)}>
      <option value="flat">$ flat</option>
      <option value="percent">% of rent</option>
    </select>
  );
  return (
    <Modal title={current ? "Change late fee rule" : "Add a late fee rule"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!valid) throw new LocalError("Enter the days and amounts as numbers.");
            if (draft.firstAmount <= 0 && draft.dailyAmount <= 0) throw new LocalError("Set a first fee, a daily fee, or both.");
            if (draft.graceDays > 60) throw new LocalError("The grace period can be at most 60 days.");
            await opsApi.saveLateFeeRule(draft);
          });
        }}
      >
        {field}
        {current && <p className="mgr-muted">This replaces the current rule for {current.label}: {describeLateFee(current)}.</p>}
        <Field label="Grace period (days late before the first fee)">
          <input inputMode="numeric" value={f.grace} onChange={(e) => set("grace", e.target.value)} required />
        </Field>
        <div className="mgr-form__row">
          <Field label="First fee">
            <span className="mgr-input-pair">
              <input inputMode="decimal" value={f.first} onChange={(e) => set("first", e.target.value)} />
              {typeSelect("firstType", "First fee type")}
            </span>
          </Field>
          <Field label="Then every day" hint="0 for none">
            <span className="mgr-input-pair">
              <input inputMode="decimal" value={f.daily} onChange={(e) => set("daily", e.target.value)} />
              {typeSelect("dailyType", "Daily fee type")}
            </span>
          </Field>
        </div>
        <Field label="Limit for one rent bill" hint="Leave empty for no limit. Many states cap late fees; check yours.">
          <span className="mgr-input-pair">
            <input inputMode="decimal" value={f.max} onChange={(e) => set("max", e.target.value)} />
            {typeSelect("maxType", "Limit type")}
          </span>
        </Field>
        {valid && !loading && <FeePreview key={`${scope.propertyId}-${scope.unitId}`} rule={draft} title="Preview" rent={rentOf()} />}
        <ErrorText error={error} />
        <Actions busy={busy} loading={loading || !existing.data} label="Save rule" onClose={onClose} />
      </form>
    </Modal>
  );
}

export function ReminderRuleDialog({ propertyId, unitId, onClose }: DialogProps<"reminderRule">) {
  const { changed } = useManager();
  const existing = useLoad(() => opsApi.reminderRules());
  const { field, scope, loading } = useScope(propertyId, unitId);
  const current = existing.data?.rules.find((r) => r.propertyId === scope.propertyId && r.unitId === scope.unitId);
  const [days, setDays] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<boolean | null>(null);
  const daysValue = days ?? String(current?.daysBefore ?? 3);
  const repeatValue = repeat ?? current?.repeatAfterDue ?? true;
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Reminder rule saved.");
  });
  return (
    <Modal title={current ? "Change rent reminders" : "Add rent reminders"} onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const n = Number(daysValue);
            if (!Number.isInteger(n) || n < 0 || n > 30) throw new LocalError("Remind between 0 and 30 days before rent is due.");
            await opsApi.saveReminderRule({ ...scope, daysBefore: n, repeatAfterDue: repeatValue });
          });
        }}
      >
        {field}
        <Field label="Days before rent is due" hint="0 sends it on the due day only.">
          <select value={daysValue} onChange={(e) => setDays(e.target.value)}>
            {[0, 1, 2, 3, 5, 7, 10, 14].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "On the due day" : `${n} day${n === 1 ? "" : "s"} before`}
              </option>
            ))}
          </select>
        </Field>
        <label className="mgr-check">
          <input type="checkbox" checked={repeatValue} onChange={(e) => setRepeat(e.target.checked)} />
          Remind every day while rent is late
        </label>
        <ErrorText error={error} />
        <Actions busy={busy} loading={loading || !existing.data} label="Save rule" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Add Charge: lease → details → repeat & review
 * ------------------------------------------------------------------ */

export function ChargeWizard({ leaseId: givenLease, label: givenLabel, onClose }: DialogProps<"charge">) {
  const { changed } = useManager();
  const units = useLoad(() => managerApi.units());
  const leased = (units.data ?? []).filter((u) => u.leaseId !== null);
  const [step, setStep] = useState(givenLease ? 2 : 1);
  const [lease, setLease] = useState(givenLease ? String(givenLease) : "");
  const [kind, setKind] = useState<ChargeKind>("utility");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(todayIso());
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [times, setTimes] = useState("12");
  const [stepError, setStepError] = useState<string | null>(null);
  const unit = leased.find((u) => String(u.leaseId) === lease);
  const label = givenLabel ?? (unit ? `Unit ${unit.unitNum} - ${unit.propertyName}` : "");
  const kindLabel = CHARGE_KINDS.find((k) => k.kind === kind)?.label ?? "Charge";
  const occurrences = repeat ? Number(times) : 1;
  const dates = Array.from({ length: Number.isInteger(occurrences) && occurrences > 0 ? Math.min(occurrences, MAX_REPEATS) : 1 }, (_, n) => addMonths(due, n));
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed(occurrences > 1 ? `${occurrences} monthly ${kindLabel.toLowerCase()} charges added to ${label}.` : `${kindLabel} added to ${label}.`);
  });

  function next() {
    setStepError(null);
    try {
      if (step === 1 && !lease) throw new LocalError("Choose the lease to charge.");
      if (step === 2) {
        parseMoney(amount, "the amount");
        if (!due) throw new LocalError("Pick the due date.");
      }
      setStep(step + 1);
    } catch (e) {
      setStepError((e as Error).message);
    }
  }

  return (
    <Modal title="Add a charge" onClose={onClose}>
      <ol className="mgr-steps" aria-label="Steps">
        {["Lease", "Charge", "Repeat & review"].map((s, i) => (
          <li key={s} className={i + 1 === step ? "mgr-steps__on" : i + 1 < step ? "mgr-steps__done" : undefined} aria-current={i + 1 === step ? "step" : undefined}>
            <span>{i + 1}</span> {s}
          </li>
        ))}
      </ol>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 3) return next();
          void run(async () => {
            if (repeat && (!Number.isInteger(occurrences) || occurrences < 2 || occurrences > MAX_REPEATS)) throw new LocalError(`Repeat between 2 and ${MAX_REPEATS} months.`);
            await opsApi.addCharges(Number(lease), { kind, amount: parseMoney(amount, "the amount"), dueDate: due, description: note.trim() || null, occurrences });
          });
        }}
      >
        {step === 1 && (
          <Field label="Lease">
            <select value={lease} onChange={(e) => setLease(e.target.value)} required>
              <option value="">Choose a unit with a lease…</option>
              {leased.map((u) => (
                <option key={u.leaseId!} value={u.leaseId!}>
                  Unit {u.unitNum} - {u.propertyName}
                  {u.tenants.length ? ` (${u.tenants.map((t) => t.name).join(", ")})` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {step === 2 && (
          <>
            <p className="mgr-muted">{label}. Rent is billed automatically each month; use this for everything else.</p>
            <fieldset className="mgr-choice-grid">
              <legend className="mgr-field__label">Type of charge</legend>
              {CHARGE_KINDS.map((k) => (
                <label key={k.kind} className={`mgr-choice${kind === k.kind ? " mgr-choice--on" : ""}`}>
                  <input type="radio" name="charge-kind" value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                  {k.label}
                </label>
              ))}
            </fieldset>
            <div className="mgr-form__row">
              <Field label="Amount">
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00" required />
              </Field>
              <Field label={repeat ? "First due date" : "Due date"}>
                <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
              </Field>
            </div>
            <Field label="Note on the statement" hint="Optional. Shown on the ledger, e.g. “Water, October”.">
              <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
        {step === 3 && (
          <>
            <fieldset className="mgr-choice-grid mgr-choice-grid--two">
              <legend className="mgr-field__label">How often</legend>
              <label className={`mgr-choice${!repeat ? " mgr-choice--on" : ""}`}>
                <input type="radio" name="repeat" checked={!repeat} onChange={() => setRepeat(false)} />
                One time
              </label>
              <label className={`mgr-choice${repeat ? " mgr-choice--on" : ""}`}>
                <input type="radio" name="repeat" checked={repeat} onChange={() => setRepeat(true)} />
                Every month
              </label>
            </fieldset>
            {repeat && (
              <Field label="Number of months" hint={`2 to ${MAX_REPEATS}. Each one is due on the same day of the month.`}>
                <input inputMode="numeric" value={times} onChange={(e) => setTimes(e.target.value)} />
              </Field>
            )}
            <div className="mgr-review">
              <dl>
                <div>
                  <dt>Lease</dt>
                  <dd>{label}</dd>
                </div>
                <div>
                  <dt>Charge</dt>
                  <dd>
                    {kindLabel}
                    {note.trim() ? ` — ${note.trim()}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>
                    {(() => {
                      try {
                        const a = parseMoney(amount, "the amount");
                        return dates.length > 1 ? `${money(a)} × ${dates.length} = ${money(a * dates.length)}` : money(a);
                      } catch {
                        return "—";
                      }
                    })()}
                  </dd>
                </div>
                <div>
                  <dt>Due</dt>
                  <dd>{dates.length > 3 ? `${isoDate(dates[0]!)}, ${isoDate(dates[1]!)} … ${isoDate(dates.at(-1)!)}` : dates.map(isoDate).join(", ")}</dd>
                </div>
              </dl>
            </div>
          </>
        )}
        <ErrorText error={stepError ?? error} />
        <div className="mgr-modal__actions">
          {step > (givenLease ? 2 : 1) ? (
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy || (step === 1 && !units.data)}>
            {step < 3 ? "Next" : busy ? "Saving…" : dates.length > 1 ? `Add ${dates.length} charges` : "Add charge"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * The unit page
 * ------------------------------------------------------------------ */

const UNIT_TAB_LABELS: ReadonlyArray<readonly [UnitTab, string]> = [
  ["overview", "Overview"],
  ["leases", "Leases"],
  ["performance", "Performance"],
  ["documents", "Documents"],
  ["charges", "Charges"],
  ["chats", "Chats"],
];
const LEASE_STATE: Record<"current" | "upcoming" | "ended", [string, string]> = {
  current: ["Current", "current"],
  upcoming: ["Moving in", "in_review"],
  ended: ["Ended", "vacant"],
};

export function UnitPage({ id, tab }: { id: number; tab: UnitTab }) {
  const { go, open, can } = useManager();
  const { data, error } = useLoad(() => opsApi.unit(id), [id]);
  if (!data) return <Loading error={error} />;
  const current = data.leases.find((l) => l.id === data.leaseId) ?? null;
  const label = `Unit ${data.unitNum} - ${data.propertyName}`;
  return (
    <>
      <Breadcrumbs trail={[["Units", { name: "rent-roll" }], [data.propertyName, { name: "property", id: data.propertyId }], [`Unit ${data.unitNum}`, null]]} />
      <PageHeader
        title={`Unit ${data.unitNum}`}
        subtitle={
          <>
            {data.propertyName} · {data.address}
          </>
        }
        actions={
          <>
            {can("maintenance:manage") && (
              <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "maintenance", unitId: id })}>
                Maintenance request
              </button>
            )}
            {current && can("ledger:adjust") && (
              <>
                <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => open({ kind: "charge", leaseId: current.id, label })}>
                  + Add charge
                </button>
                <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "payment", leaseId: current.id })}>
                  Record a payment
                </button>
              </>
            )}
            {!current && can("users:provision") && (
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "lease", unitId: id })}>
                + New lease
              </button>
            )}
          </>
        }
      />
      <PageTabs label="Unit" tabs={UNIT_TAB_LABELS} active={tab} href={(t) => ({ name: "unit", id, tab: t })} />
      {tab === "overview" && (
        <div className="mgr-columns">
          <section className="mgr-card">
            <div className="mgr-card__head">
              <h2 className="mgr-h2">Lease details</h2>
              {current && (
                <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: current.id })}>
                  Open lease
                </button>
              )}
            </div>
            {current ? (
              <dl className="mgr-facts">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span className={`mgr-pill mgr-pill--${LEASE_STATE[current.state][1]}`}>{LEASE_STATE[current.state][0]}</span>
                  </dd>
                </div>
                <div>
                  <dt>Lease start</dt>
                  <dd>{isoDate(current.startDate)}</dd>
                </div>
                <div>
                  <dt>Lease end</dt>
                  <dd>{current.endDate ? isoDate(current.endDate) : "Month to month"}</dd>
                </div>
                <div>
                  <dt>Monthly rent</dt>
                  <dd>{money(current.monthlyRent)}</dd>
                </div>
                <div>
                  <dt>Balance</dt>
                  <dd className={current.balance > 0 ? "mgr-owes" : undefined}>{money(current.balance)}</dd>
                </div>
              </dl>
            ) : (
              <Empty>Vacant. No current or upcoming lease.</Empty>
            )}
          </section>
          <section className="mgr-card">
            <div className="mgr-card__head">
              <h2 className="mgr-h2">Tenants</h2>
              {current && can("users:provision") && (
                <button type="button" className="mgr-btn mgr-btn--link" onClick={() => open({ kind: "addResident", leaseId: current.id })}>
                  + Add tenant
                </button>
              )}
            </div>
            {current && current.tenants.length ? (
              <ul className="mgr-people-list">
                {current.tenants.map((t) => (
                  <li key={t.id}>
                    <a
                      href={`#/tenants/${t.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go({ name: "tenant", id: t.id, tab: "overview" });
                      }}
                    >
                      <strong>{t.name}</strong>
                    </a>
                    {can("messages:manage") && (
                      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "messages", tenantId: t.id })}>
                        Message
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No tenants on this unit.</Empty>
            )}
          </section>
          <section className="mgr-card">
            <div className="mgr-card__head">
              <h2 className="mgr-h2">Maintenance</h2>
              <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "maintenance" })}>
                Open queue
              </button>
            </div>
            {data.maintenance.filter((m) => m.status !== "resolved").length === 0 ? (
              <Empty>No open requests.</Empty>
            ) : (
              <ul className="mgr-mini-list">
                {data.maintenance
                  .filter((m) => m.status !== "resolved")
                  .map((m) => (
                    <li key={m.id}>
                      <span>{m.title}</span>
                      <StatusPill status={m.status} />
                    </li>
                  ))}
              </ul>
            )}
          </section>
          <section className="mgr-card">
            <h2 className="mgr-h2">Last 12 months</h2>
            <dl className="mgr-facts">
              <div>
                <dt>Collected</dt>
                <dd>
                  {money(data.performance.collected)} of {money(data.performance.billed)}
                </dd>
              </div>
              <div>
                <dt>Rent paid on time</dt>
                <dd>{pct(data.performance.onTimeRate)}</dd>
              </div>
              <div>
                <dt>Months leased</dt>
                <dd>{data.performance.monthsLeased} of 12</dd>
              </div>
            </dl>
            <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "unit", id, tab: "performance" })}>
              See performance
            </button>
          </section>
        </div>
      )}
      {tab === "leases" && (
        <section className="mgr-card">
          {data.leases.length === 0 ? (
            <Empty>This unit has never been leased.</Empty>
          ) : (
            <div className="mgr-table-wrap">
              <table className="mgr-table">
                <thead>
                  <tr>
                    <th scope="col">Lease</th>
                    <th scope="col">Tenants</th>
                    <th scope="col" className="mgr-num">Rent</th>
                    <th scope="col" className="mgr-num">Balance</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span className="mgr-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.leases.map((l) => (
                    <tr key={l.id}>
                      <th scope="row">
                        {isoDate(l.startDate)} – {l.endDate ? isoDate(l.endDate) : "month to month"}
                      </th>
                      <td>{l.tenants.map((t) => t.name).join(", ") || "—"}</td>
                      <td className="mgr-num">{money(l.monthlyRent)}</td>
                      <td className={`mgr-num${l.balance > 0 ? " mgr-owes" : ""}`}>{money(l.balance)}</td>
                      <td>
                        <span className={`mgr-pill mgr-pill--${LEASE_STATE[l.state][1]}`}>{LEASE_STATE[l.state][0]}</span>
                      </td>
                      <td className="mgr-row-actions">
                        <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "lease", id: l.id })}>
                          Open lease
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {tab === "performance" && (
        <div className="mgr-kpis">
          <Kpi label="Billed" value={money(data.performance.billed, false)} note="Last 12 months" />
          <Kpi label="Collected" value={money(data.performance.collected, false)} note={`${pct(data.performance.collectionRate)} of what was billed`} tone="good" />
          <Kpi label="On-time rent" value={pct(data.performance.onTimeRate)} note="Rent paid in full by the grace day" />
          <Kpi label="Months leased" value={`${data.performance.monthsLeased} / 12`} note="Occupancy, last 12 months" />
          <Kpi label="Open requests" value={String(data.performance.openRequests)} note="Maintenance not completed" onClick={() => go({ name: "maintenance" })} />
          <Kpi label="Balance now" value={money(current?.balance ?? 0)} tone={(current?.balance ?? 0) > 0 ? "warn" : undefined} note={current ? "Current lease" : "No current lease"} />
        </div>
      )}
      {tab === "documents" && <LeaseDocuments leases={data.leases} label={label} />}
      {tab === "charges" && (current ? <LeaseCharges leaseId={current.id} unitId={id} label={label} /> : <Empty>No current lease, so no charges to show. Past leases are under Leases.</Empty>)}
      {tab === "chats" && <Chats tenants={current?.tenants ?? []} />}
    </>
  );
}

function LeaseDocuments({ leases, label }: { leases: Array<{ id: number; startDate: string; endDate: string | null; document: { filename: string; uploadedAt: string } | null }>; label: string }) {
  const { open, can } = useManager();
  if (leases.length === 0) return <Empty>No leases yet, so no lease documents.</Empty>;
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Signed leases</h2>
      <ul className="mgr-doc-list">
        {leases.map((l) => (
          <li key={l.id}>
            <span className="mgr-doc-list__icon" aria-hidden="true">PDF</span>
            <div>
              <strong>{l.document ? l.document.filename : "No signed lease on file"}</strong>
              <span className="mgr-muted">
                Lease {isoDate(l.startDate)} – {l.endDate ? isoDate(l.endDate) : "month to month"}
                {l.document ? ` · uploaded ${timeAgo(l.document.uploadedAt)}` : ""}
              </span>
            </div>
            <div className="mgr-row-actions">
              {l.document && (
                <a className="mgr-btn mgr-btn--secondary mgr-btn--small" href={leaseDocumentUrl(l.id)} target="_blank" rel="noopener">
                  View PDF
                </a>
              )}
              {can("users:provision") && (
                <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "leaseDocument", leaseId: l.id, label })}>
                  {l.document ? "Replace" : "Upload PDF"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A lease's charges (paid / due / late) or its running ledger. */
function LeaseCharges({ leaseId, unitId, label }: { leaseId: number; unitId?: number; label: string }) {
  const { open, can } = useManager();
  const [mode, setMode] = useState<"charges" | "ledger">("charges");
  const charges = useLoad(() => opsApi.charges(ALL_FROM, ALL_TO), []);
  const lease = useLoad(() => managerApi.lease(leaseId), [leaseId]);
  const rows = (charges.data?.rows ?? []).filter((r) => r.leaseId === leaseId && (unitId === undefined || r.unitId === unitId));
  const ledger = lease.data?.ledger ?? [];
  const exportCsv = () =>
    mode === "charges"
      ? downloadCsv(`charges-lease-${leaseId}.csv`, [["Due", "Charge", "Description", "Amount", "Paid", "Unpaid", "Status"], ...rows.map((r) => [r.dueDate, r.kindLabel, r.description, r.amount, r.paid, r.unpaid, r.status])])
      : downloadCsv(`ledger-lease-${leaseId}.csv`, [["Date", "Description", "Method", "Amount", "Balance"], ...ledger.map((e) => [e.date, e.description, e.method ?? "", e.amount, e.balanceAfter])]);
  return (
    <section className="mgr-card mgr-printable">
      <div className="mgr-card__head">
        <div className="mgr-tabs" role="tablist" aria-label="Show">
          {(["charges", "ledger"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`mgr-tab${mode === m ? " mgr-tab--active" : ""}`} onClick={() => setMode(m)}>
              {m === "charges" ? "Charges" : "Ledger"}
            </button>
          ))}
        </div>
        <div className="mgr-row-actions">
          {can("ledger:adjust") && (
            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "charge", leaseId, label })}>
              + Add charge
            </button>
          )}
          <MoreMenu items={[["Export CSV", exportCsv], ["Print", () => window.print()]]} />
        </div>
      </div>
      {mode === "charges" ? (
        !charges.data ? (
          <Loading error={charges.error} />
        ) : rows.length === 0 ? (
          <Empty>No charges yet.</Empty>
        ) : (
          <div className="mgr-table-wrap">
            <table className="mgr-table mgr-table--compact">
              <thead>
                <tr>
                  <th scope="col">Due</th>
                  <th scope="col">Charge</th>
                  <th scope="col" className="mgr-num">Amount</th>
                  <th scope="col" className="mgr-num">Paid</th>
                  <th scope="col" className="mgr-num">Unpaid</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{isoDate(r.dueDate)}</td>
                    <th scope="row">
                      {r.kindLabel}
                      {r.description !== r.kindLabel && <div className="mgr-muted">{r.description}</div>}
                    </th>
                    <td className="mgr-num">{money(r.amount)}</td>
                    <td className="mgr-num">{money(r.paid)}</td>
                    <td className={`mgr-num${r.unpaid > 0 ? " mgr-owes" : ""}`}>{money(r.unpaid)}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !lease.data ? (
        <Loading error={lease.error} />
      ) : ledger.length === 0 ? (
        <Empty>No ledger lines yet.</Empty>
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
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{e.date}</td>
                  <td>{e.description}</td>
                  <td className="mgr-muted">{e.method ?? "—"}</td>
                  <td className={`mgr-num ${e.amount > 0 ? "mgr-credit" : ""}`}>{e.amount > 0 ? `+${money(e.amount)}` : money(e.amount)}</td>
                  <td className="mgr-num">{money(e.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Chats({ tenants }: { tenants: Array<{ id: number; name: string }> }) {
  const { go, can } = useManager();
  if (!can("messages:manage")) return <Empty>Your role cannot read messages.</Empty>;
  if (tenants.length === 0) return <Empty>No tenants to message.</Empty>;
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Conversations</h2>
      <ul className="mgr-people-list">
        {tenants.map((t) => (
          <li key={t.id}>
            <strong>{t.name}</strong>
            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "messages", tenantId: t.id })}>
              Open conversation
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The tenant page
 * ------------------------------------------------------------------ */

const TENANT_TAB_LABELS: ReadonlyArray<readonly [TenantTab, string]> = [
  ["overview", "Overview"],
  ["charges", "Charges"],
  ["documents", "Documents"],
  ["chats", "Chats"],
];

function StatusTile({ ok, title, detail, action }: { ok: boolean; title: string; detail: ReactNode; action?: ReactNode }) {
  return (
    <div className={`mgr-status-tile${ok ? " mgr-status-tile--ok" : ""}`}>
      <strong>
        <span aria-hidden="true">{ok ? "✓" : "!"}</span> {title}
      </strong>
      <span className="mgr-muted">{detail}</span>
      {action}
    </div>
  );
}

export function TenantPage({ id, tab }: { id: number; tab: TenantTab }) {
  const { go, open, can } = useManager();
  const tenants = useLoad(() => managerApi.tenants());
  const t = tenants.data?.find((x) => x.id === id);
  const lease = useLoad(() => (t?.leaseId ? managerApi.lease(t.leaseId) : Promise.resolve(null)), [t?.leaseId]);
  const docs = useLoad(() => (t?.leaseId ? opsApi.documents() : Promise.resolve([])), [t?.leaseId]);
  if (tenants.data && !t) return <Empty>That tenant was not found.</Empty>;
  if (!t) return <Loading error={tenants.error} />;
  const l = lease.data;
  const lastPayment = l?.ledger.filter((e) => e.amount > 0).at(-1);
  const label = l ? `Unit ${l.unitNum} - ${l.propertyName}` : "";
  return (
    <>
      <Breadcrumbs trail={[["Tenants", { name: "tenants" }], [t.name, null]]} />
      <PageHeader
        title={t.name}
        subtitle={t.unitLabel ? `Tenant at ${t.unitLabel}` : "No current lease"}
        actions={
          <>
            {can("messages:manage") && (
              <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => go({ name: "messages", tenantId: t.id })}>
                Message
              </button>
            )}
            {can("users:provision") && (
              <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => open({ kind: "editTenant", id: t.id, name: t.name, phone: t.phone })}>
                Edit details
              </button>
            )}
          </>
        }
      />
      <PageTabs label="Tenant" tabs={TENANT_TAB_LABELS} active={tab} href={(k) => ({ name: "tenant", id, tab: k })} />
      {tab === "overview" && (
        <>
          <div className="mgr-status-tiles">
            <StatusTile ok={t.signedUp} title={t.signedUp ? "Signed up" : "Not signed up"} detail={t.signedUp ? "Uses the resident portal" : "Has not used their sign-up link yet"} />
            <StatusTile ok={t.leaseId !== null && t.balance <= 0} title={t.leaseId === null ? "No lease" : t.balance > 0 ? `Owes ${money(t.balance)}` : t.balance < 0 ? `${money(-t.balance)} credit` : "Paid up"} detail={t.unitLabel ?? "Not on a lease"} />
            <StatusTile ok={!!lastPayment} title={lastPayment ? "Last payment" : "No payments yet"} detail={lastPayment ? `${money(lastPayment.amount)} on ${lastPayment.date}${lastPayment.method ? ` · ${lastPayment.method}` : ""}` : "Nothing received on this lease"} />
            <StatusTile ok={!!t.phone} title={t.phone ? "Phone on file" : "No phone"} detail={t.phone ?? "Add one under Edit details"} />
          </div>
          <div className="mgr-columns">
            <section className="mgr-card">
              <div className="mgr-card__head">
                <h2 className="mgr-h2">General info</h2>
                {can("users:provision") && (
                  <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "editTenant", id: t.id, name: t.name, phone: t.phone })}>
                    Edit details
                  </button>
                )}
              </div>
              <dl className="mgr-facts">
                <div>
                  <dt>Name</dt>
                  <dd>{t.name}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${t.email}`}>{t.email}</a>
                  </dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{t.phone ?? "—"}</dd>
                </div>
                <div>
                  <dt>Account</dt>
                  <dd>{t.signedUp ? "Signed up" : "Invited"}</dd>
                </div>
              </dl>
            </section>
            <section className="mgr-card">
              <div className="mgr-card__head">
                <h2 className="mgr-h2">Lease details</h2>
                {l && (
                  <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "unit", id: l.unitId, tab: "overview" })}>
                    View unit
                  </button>
                )}
              </div>
              {!t.leaseId ? (
                <Empty>Not on a current lease.</Empty>
              ) : !l ? (
                <Loading error={lease.error} />
              ) : (
                <>
                  <dl className="mgr-facts">
                    <div>
                      <dt>Unit</dt>
                      <dd>{label}</dd>
                    </div>
                    <div>
                      <dt>Lease start</dt>
                      <dd>{isoDate(l.startDate)}</dd>
                    </div>
                    <div>
                      <dt>Lease end</dt>
                      <dd>{l.endDate ? isoDate(l.endDate) : "Month to month"}</dd>
                    </div>
                    <div>
                      <dt>Monthly rent</dt>
                      <dd>{money(l.monthlyRent)}</dd>
                    </div>
                  </dl>
                  <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "lease", id: l.id })}>
                    Open lease
                  </button>
                </>
              )}
            </section>
          </div>
        </>
      )}
      {tab === "charges" && (t.leaseId ? <LeaseCharges leaseId={t.leaseId} label={label || (t.unitLabel ?? "")} /> : <Empty>Not on a current lease, so there are no charges.</Empty>)}
      {tab === "documents" &&
        (!t.leaseId ? (
          <Empty>Not on a current lease, so there are no documents.</Empty>
        ) : !docs.data ? (
          <Loading error={docs.error} />
        ) : (
          <DocumentTable rows={docs.data.filter((d) => d.leaseId === t.leaseId)} />
        ))}
      {tab === "chats" && <Chats tenants={[{ id: t.id, name: t.name }]} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

function DocumentTable({ rows }: { rows: Awaited<ReturnType<typeof opsApi.documents>> }) {
  if (rows.length === 0) return <Empty>No documents.</Empty>;
  return (
    <section className="mgr-card">
      <div className="mgr-table-wrap">
        <table className="mgr-table">
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">Unit</th>
              <th scope="col">Tenants</th>
              <th scope="col">Uploaded</th>
              <th scope="col"><span className="mgr-sr">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={`${d.kind}-${d.leaseId}-${d.paymentId ?? 0}-${d.filename}`}>
                <th scope="row">
                  {d.filename}
                  <div className="mgr-muted">
                    {d.kind === "lease" ? "Signed lease" : "Payment receipt"} · {fmtSize(d.sizeBytes)}
                  </div>
                </th>
                <td>{d.unitLabel}</td>
                <td>{d.tenants.join(", ") || "—"}</td>
                <td className="mgr-muted">
                  {timeAgo(d.uploadedAt)}
                  {d.uploadedBy && <div>{d.uploadedBy}</div>}
                </td>
                <td className="mgr-row-actions">
                  <a
                    className="mgr-btn mgr-btn--secondary mgr-btn--small"
                    href={d.kind === "lease" ? leaseDocumentUrl(d.leaseId) : receiptUrl(d.leaseId, d.paymentId!)}
                    target="_blank"
                    rel="noopener"
                  >
                    View
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DocumentsPage() {
  const { open, can } = useManager();
  const { data, error } = useLoad(() => opsApi.documents());
  const [kind, setKind] = useState<"all" | "lease" | "receipt">("all");
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const all = data ?? [];
  const rows = all.filter((d) => (kind === "all" || d.kind === kind) && (!q || d.filename.toLowerCase().includes(q) || d.unitLabel.toLowerCase().includes(q) || d.tenants.some((t) => t.toLowerCase().includes(q))));
  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Signed leases and payment receipts on file. Files open only for signed-in office staff."
        actions={
          can("users:provision") && (
            <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "leaseDocument" })}>
              Upload lease PDF
            </button>
          )
        }
      />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mgr-viewcards">
            <ViewCard label="All documents" value={String(all.length)} note="View all" active={kind === "all"} onClick={() => setKind("all")} />
            <ViewCard label="Signed leases" value={String(all.filter((d) => d.kind === "lease").length)} note="View leases" active={kind === "lease"} onClick={() => setKind("lease")} />
            <ViewCard label="Receipts" value={String(all.filter((d) => d.kind === "receipt").length)} note="View receipts" active={kind === "receipt"} onClick={() => setKind("receipt")} />
          </div>
          <div className="mgr-toolbar">
            <input type="search" aria-label="Search documents" placeholder="Search file, unit or tenant" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <DocumentTable rows={rows} />
        </>
      )}
    </>
  );
}

export function LeaseDocumentDialog({ leaseId: givenLease, label: givenLabel, onClose }: DialogProps<"leaseDocument">) {
  const { changed } = useManager();
  const units = useLoad(() => managerApi.units());
  const [lease, setLease] = useState(givenLease ? String(givenLease) : "");
  const [file, setFile] = useState<ReceiptUpload | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const leased = (units.data ?? []).filter((u: UnitRow) => u.leaseId !== null);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Signed lease uploaded.");
  });
  async function pick(f: File | undefined) {
    setPickError(null);
    setFile(null);
    if (!f) return;
    try {
      if (f.type !== "application/pdf") throw new Error("Upload the signed lease as a PDF.");
      if (f.size > RECEIPT_MAX_BYTES) throw new Error("That PDF is over 4 MB.");
      setFile(await readReceipt(f));
    } catch (e) {
      setPickError((e as Error).message);
    }
  }
  return (
    <Modal title="Upload signed lease" onClose={onClose}>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!lease) throw new LocalError("Choose the lease.");
            if (!file) throw new LocalError("Choose the PDF.");
            await opsApi.uploadLeaseDocument(Number(lease), file);
          });
        }}
      >
        {givenLease ? (
          <p className="mgr-muted">{givenLabel}</p>
        ) : (
          <Field label="Lease">
            <select value={lease} onChange={(e) => setLease(e.target.value)} required>
              <option value="">Choose a unit with a lease…</option>
              {leased.map((u) => (
                <option key={u.leaseId!} value={u.leaseId!}>
                  Unit {u.unitNum} - {u.propertyName}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Signed lease (PDF, up to 4 MB)" hint="Replaces any lease PDF already on file for this lease. Tenants can open it from their portal.">
          <input type="file" accept="application/pdf" onChange={(e) => void pick(e.target.files?.[0])} />
        </Field>
        <ErrorText error={pickError ?? error} />
        <Actions busy={busy} loading={!givenLease && !units.data} disabled={!file} label="Upload" onClose={onClose} />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Settings: Account | Payment options | Notifications | Team
 * ------------------------------------------------------------------ */

const SETTINGS_TAB_LABELS: ReadonlyArray<readonly [SettingsTab, string]> = [
  ["account", "Account"],
  ["payment-options", "Payment options"],
  ["notifications", "Notifications"],
  ["team", "Team"],
];

const ROLE_TEXT: Record<string, string> = { admin: "Property manager", property_manager: "Property manager", maintenance_staff: "Maintenance", platform_admin: "Administrator" };

function AccountSettings() {
  const { user } = useManager();
  const { data, error } = useLoad(() => managerApi.me());
  if (!data) return <Loading error={error} />;
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Account info</h2>
      <dl className="mgr-facts">
        <div>
          <dt>Name</dt>
          <dd>{data.name}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{data.email}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{ROLE_TEXT[data.role] ?? ROLE_TEXT[user.role] ?? data.role}</dd>
        </div>
      </dl>
      <h3 className="mgr-h3">Sign-in security</h3>
      <ul className="mgr-checks">
        <li>Sessions end after inactivity, and signing out ends this session everywhere it was used.</li>
        <li>Repeated wrong passwords lock the account for a while and the office is warned.</li>
        <li>What you can see and change is set by your role, checked by the server on every request.</li>
      </ul>
    </section>
  );
}

function NotificationSettings() {
  const { can, changed } = useManager();
  const { data, error } = useLoad(() => opsApi.notifications());
  const [form, setForm] = useState<Partial<{ notifyEmail: string; newMaintenance: boolean; tenantMessage: boolean; reportedPayment: boolean; lateRent: boolean }>>({});
  const editable = can("users:provision");
  const { busy, error: saveError, run } = useSubmit(() => {
    setForm({});
    changed("Notification settings saved.");
  });
  if (!data) return <Loading error={error} />;
  const v = { notifyEmail: data.notifyEmail ?? "", newMaintenance: data.newMaintenance, tenantMessage: data.tenantMessage, reportedPayment: data.reportedPayment, lateRent: data.lateRent, ...form };
  const groups: Array<[string, string, Array<[keyof typeof v & ("newMaintenance" | "tenantMessage" | "reportedPayment" | "lateRent"), string]>]> = [
    ["Payments", "Tenant payments that need the office", [["reportedPayment", "A tenant reports a Cash App or Zelle payment to confirm"]]],
    ["Rent & Charges", "Overdue balances", [["lateRent", "Rent becomes late (once a day, one summary)"]]],
    ["Maintenance", "Requests from tenants", [["newMaintenance", "A tenant submits a maintenance request"]]],
    ["Chat", "Messages from tenants", [["tenantMessage", "A tenant sends a message"]]],
  ];
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Notification preferences</h2>
      <p className="mgr-muted">What the office is told about, and where. Changes apply to the whole office.</p>
      <form
        className="mgr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const email = v.notifyEmail.trim();
            if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new LocalError("Enter a valid email address, or leave it empty.");
            await opsApi.saveNotifications({ notifyEmail: email || null, newMaintenance: v.newMaintenance, tenantMessage: v.tenantMessage, reportedPayment: v.reportedPayment, lateRent: v.lateRent });
          });
        }}
      >
        <Field label="Send office notifications to" hint="Leave empty to use each manager's own sign-in email.">
          <input type="email" maxLength={254} value={v.notifyEmail} onChange={(e) => setForm({ ...form, notifyEmail: e.target.value })} disabled={!editable} placeholder="office@yourcompany.com" />
        </Field>
        {groups.map(([title, sub, items]) => (
          <fieldset key={title} className="mgr-notify-group">
            <legend>
              <strong>{title}</strong> <span className="mgr-muted">{sub}</span>
            </legend>
            {items.map(([key, text]) => (
              <label key={key} className="mgr-check">
                <input type="checkbox" checked={v[key]} disabled={!editable} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                {text}
              </label>
            ))}
          </fieldset>
        ))}
        <ErrorText error={saveError} />
        {editable ? (
          <div className="mgr-modal__actions">
            <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy || Object.keys(form).length === 0}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <p className="mgr-muted">Only a property manager can change these.</p>
        )}
      </form>
    </section>
  );
}

function TeamSettings() {
  const { data, error } = useLoad(() => opsApi.staff());
  if (!data) return <Loading error={error} />;
  return (
    <section className="mgr-card">
      <h2 className="mgr-h2">Team</h2>
      <p className="mgr-muted">Everyone with an office sign-in. Property managers see everything; maintenance staff see the maintenance queue only.</p>
      {data.length === 0 ? (
        <Empty>No team members.</Empty>
      ) : (
        <div className="mgr-table-wrap">
          <table className="mgr-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={`${s.role}-${s.id}`}>
                  <th scope="row">{s.name}</th>
                  <td>
                    <a href={`mailto:${s.email}`}>{s.email}</a>
                  </td>
                  <td>{ROLE_TEXT[s.role] ?? s.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  return (
    <>
      <PageHeader title="Settings" subtitle="Your account, how tenants can pay, what the office is told about, and the team." />
      <PageTabs label="Settings" tabs={SETTINGS_TAB_LABELS} active={tab} href={(t) => ({ name: "settings", tab: t })} />
      {tab === "account" && <AccountSettings />}
      {tab === "payment-options" && <PaymentOptionsPage embedded />}
      {tab === "notifications" && <NotificationSettings />}
      {tab === "team" && <TeamSettings />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Create new: every "add" in one place
 * ------------------------------------------------------------------ */

export function CreateNewDialog({ onClose }: DialogProps<"create">) {
  const { open, go, can } = useManager();
  const pickDialog = (d: Dialog) => () => open(d);
  const pickRoute = (r: Parameters<typeof go>[0]) => () => {
    onClose();
    go(r);
  };
  const groups: Array<[string, Array<[string, () => void, boolean]>]> = [
    ["Properties", [["Property", pickDialog({ kind: "property" }), can("users:provision")], ["Unit", pickDialog({ kind: "unit" }), can("users:provision")], ["Set up a property", pickRoute({ name: "setup" }), can("users:provision")]]],
    ["Charges", [["Charge", pickDialog({ kind: "charge" }), can("ledger:adjust")], ["Payment", pickDialog({ kind: "payment" }), can("ledger:adjust")]]],
    ["People", [["Tenant", pickDialog({ kind: "tenant" }), can("users:provision")], ["Lease", pickDialog({ kind: "lease" }), can("users:provision")]]],
    ["Payment rules", [["Late fee rule", pickDialog({ kind: "lateFeeRule" }), can("ledger:adjust")], ["Rent reminder", pickDialog({ kind: "reminderRule" }), can("ledger:adjust")]]],
    ["Maintenance", [["Maintenance request", pickDialog({ kind: "maintenance" }), can("maintenance:manage")]]],
    ["Documents", [["Signed lease PDF", pickDialog({ kind: "leaseDocument" }), can("users:provision")]]],
    ["Communication", [["Message", pickRoute({ name: "messages" }), can("messages:manage")]]],
    ["Accounting", [["Expense", pickDialog({ kind: "expense" }), can("ledger:adjust")]]],
  ];
  const visible = groups.map(([g, items]) => [g, items.filter(([, , ok]) => ok)] as const).filter(([, items]) => items.length > 0);
  return (
    <Modal title="What would you like to create?" onClose={onClose}>
      <div className="mgr-create">
        {visible.map(([g, items]) => (
          <section key={g}>
            <h3 className="mgr-create__group">{g}</h3>
            <div className="mgr-create__items">
              {items.map(([label, run]) => (
                <button key={label} type="button" className="mgr-btn mgr-btn--secondary" onClick={run}>
                  + {label}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Tenants: who is current, moving in, leaving, or a prior tenant
 * ------------------------------------------------------------------ */

export type TenantStage = "current" | "moving-in" | "leaving" | "prior";

/** Each tenant's stage from the unit they are on (lease dates) — leaving means the lease ends within 60 days. */
export function tenantStages(tenants: TenantRow[], units: UnitRow[], today: string): Map<number, { stage: TenantStage; daysLeft: number | null; startDate: string | null; endDate: string | null }> {
  const byTenant = new Map<number, UnitRow>();
  for (const u of units) for (const t of u.tenants) if (u.leaseId !== null) byTenant.set(t.id, u);
  const out = new Map<number, { stage: TenantStage; daysLeft: number | null; startDate: string | null; endDate: string | null }>();
  for (const t of tenants) {
    const u = t.leaseId !== null ? byTenant.get(t.id) : undefined;
    if (!u || t.leaseId === null) {
      out.set(t.id, { stage: "prior", daysLeft: null, startDate: null, endDate: null });
      continue;
    }
    const daysLeft = u.endDate ? Math.round((Date.parse(`${u.endDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null;
    const stage: TenantStage = u.startDate && u.startDate > today ? "moving-in" : daysLeft !== null && daysLeft <= 60 ? "leaving" : "current";
    out.set(t.id, { stage, daysLeft, startDate: u.startDate, endDate: u.endDate });
  }
  return out;
}
