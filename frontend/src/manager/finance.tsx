// Finance (collections), Profit & Loss, Performance and Lease renewals: the
// manager's money screens, plus the expense and renewal-notice dialogs.
// Numbers come from /api/manager/finance, /analytics and /leases/expiring;
// nothing here is calculated from guesses in the browser.
import { useMemo, useRef, useState, type FormEvent } from "react";
import { managerApi } from "./api";
import { AgingBar, CollectionGauge, HBars, IncomeExpenseChart, PercentLines, SERIES } from "./charts";
import {
  downloadCsv,
  EXPENSE_CATEGORIES,
  expenseLabel,
  financeApi,
  MANUAL_PAY_LABELS,
  PERIODS,
  type CollectionRow,
  type ExpenseCategory,
  type ExpiringLeaseRow,
  type FinancePeriod,
  type RecentPaymentRow,
  type ReportedPaymentRow,
} from "./finance-api";
import { SortSelect, SortTh, useSort } from "./sort";
import { Empty, Field, Kpi, Loading, LocalError, Modal, PageHeader, isoDate, money, timeAgo, todayIso, useLoad, useManager, useSubmit, type Dialog } from "./ui";

const pct = (r: number) => `${Math.round(r * 100)}%`;
// The API sends the P&L label ("Late fees"); one charge reads better singular.
const CHARGE_LABELS: Record<string, string> = { "Late fees": "Late fee", "Security deposits": "Deposit", Utilities: "Utility bill", "Other charges": "Charge" };
const PAYMENT_STATUS: Record<RecentPaymentRow["status"], string> = { paid: "Paid", partial: "Partial", prepaid: "Paid ahead", refund: "Refund" };

function PeriodPicker({ value, onChange }: { value: FinancePeriod; onChange: (p: FinancePeriod) => void }) {
  return (
    <label className="mgr-period">
      <span className="mgr-sr">Period</span>
      <select value={value} onChange={(e) => onChange(e.target.value as FinancePeriod)}>
        {PERIODS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Contact({ tenants }: { tenants: CollectionRow["tenants"] }) {
  if (tenants.length === 0) return <span className="mgr-muted">—</span>;
  return (
    <>
      {tenants.map((t) => (
        <div key={t.id} className="mgr-contact">
          <strong>{t.name}</strong>
          <span className="mgr-muted">
            {t.phone ? <a href={`tel:${t.phone.replace(/[^\d+]/g, "")}`}>{t.phone}</a> : "No phone on file"}
          </span>
          <span className="mgr-muted">
            <a href={`mailto:${t.email}`}>{t.email}</a>
          </span>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Finance: collections first, then money in and out
 * ------------------------------------------------------------------ */

type LateBand = "all" | "current" | "1-30" | "31-60" | "61-90" | "90+";
const bandOf = (r: CollectionRow): Exclude<LateBand, "all"> =>
  r.daysLate <= 0 ? "current" : r.daysLate <= 30 ? "1-30" : r.daysLate <= 60 ? "31-60" : r.daysLate <= 90 ? "61-90" : "90+";

export function FinancePage({ period }: { period: FinancePeriod }) {
  const { go, open, can } = useManager();
  const { data, error } = useLoad(() => financeApi.overview(period), [period]);
  const setPeriod = (p: FinancePeriod) => go({ name: "finance", period: p });

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle={data ? `Collections, money in and money out · ${data.period.label} (${isoDate(data.period.from)} – ${isoDate(data.period.to)})` : "Collections, money in and money out."}
        actions={
          <>
            <PeriodPicker value={period} onChange={setPeriod} />
            {can("ledger:adjust") && (
              <button type="button" className="mgr-btn mgr-btn--secondary" onClick={() => open({ kind: "expense" })}>
                + Add expense
              </button>
            )}
            {can("ledger:adjust") && (
              <button type="button" className="mgr-btn mgr-btn--primary" onClick={() => open({ kind: "payment" })}>
                Record a payment
              </button>
            )}
          </>
        }
      />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className="mgr-fin-top">
            <section className="mgr-card mgr-fin-gauge" aria-labelledby="fin-payments">
              <h2 className="mgr-h2" id="fin-payments">Payments</h2>
              <p className="mgr-muted">Every charge due in the period ({data.period.label}), and where each stands today.</p>
              <CollectionGauge paid={data.summary.paid} open={data.summary.open} late={data.summary.late} />
            </section>
            <div className="mgr-kpis mgr-kpis--fin">
              <Kpi label="All charges due" value={money(data.summary.chargesDue, false)} note={data.period.label} />
              <Kpi label="Total paid" value={money(data.summary.paid, false)} note={`${pct(data.summary.collectedRate)} of what was due`} tone="good" />
              <Kpi label="Late" value={money(data.summary.late, false)} note={`Unpaid ${data.lateAfterDays === 0 ? "after the due date" : `${data.lateAfterDays}+ days after due`}`} tone={data.summary.late > 0 ? "warn" : undefined} />
              <Kpi label="Owed, all time" value={money(data.aging.total, false)} note={`${data.aging.accounts} account${data.aging.accounts === 1 ? "" : "s"} with a balance`} tone={data.aging.total > 0 ? "warn" : undefined} onClick={() => document.getElementById("fin-collections")?.scrollIntoView({ behavior: "smooth" })} />
              <Kpi label="Cash collected" value={money(data.summary.cashCollected, false)} note={data.summary.refunds ? `After ${money(data.summary.refunds)} refunded` : "Money received in the period"} />
              <Kpi label="Expenses" value={money(data.summary.expenses, false)} note={`${data.expenses.length} item${data.expenses.length === 1 ? "" : "s"} logged`} />
              <Kpi label="Net" value={money(data.summary.net, false)} note="Collected − expenses" tone={data.summary.net >= 0 ? "good" : "warn"} onClick={() => go({ name: "pnl", period })} />
            </div>
          </div>

          <ReportedPayments />
          <Collections rows={data.collections} aging={data.aging} />
          <section className="mgr-card" aria-labelledby="fin-monthly">
            <div className="mgr-card__head">
              <h2 className="mgr-h2" id="fin-monthly">Monthly income vs expenses</h2>
              <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "pnl", period: "12m" })}>
                Open Profit &amp; Loss
              </button>
            </div>
            <p className="mgr-muted">Last 12 months. Collected is money received, after refunds.</p>
            <IncomeExpenseChart months={data.monthly.map((m) => ({ label: m.label, income: m.collected, expenses: m.expenses, net: m.net, billed: m.billed }))} />
            <MonthTable months={data.monthly} />
          </section>
          <RecentPayments rows={data.recentPayments} />
          <ExpenseList rows={data.expenses} periodLabel={data.period.label} />
        </>
      )}
    </>
  );
}

function MonthTable({ months }: { months: Array<{ month: string; label: string; billed: number; collected: number; expenses: number; net: number }> }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button type="button" className="mgr-btn mgr-btn--link" aria-expanded={show} onClick={() => setShow(!show)}>
        {show ? "Hide the numbers" : "Show the numbers as a table"}
      </button>
      {show && (
        <div className="mgr-table-wrap">
          <table className="mgr-table mgr-table--compact">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="mgr-num">Billed</th>
                <th scope="col" className="mgr-num">Collected</th>
                <th scope="col" className="mgr-num">Expenses</th>
                <th scope="col" className="mgr-num">Net</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.label}</th>
                  <td className="mgr-num">{money(m.billed)}</td>
                  <td className="mgr-num">{money(m.collected)}</td>
                  <td className="mgr-num">{money(m.expenses)}</td>
                  <td className={`mgr-num${m.net < 0 ? " mgr-owes" : ""}`}>{money(m.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Only the buckets that hold money, oldest first ("31–60 days  $910"). */
function AgingLines({ row }: { row: CollectionRow }) {
  const parts: Array<[string, number]> = [
    ["90+ days", row.d90plus],
    ["61–90 days", row.d61_90],
    ["31–60 days", row.d31_60],
    ["1–30 days", row.d1_30],
    ["Not late yet", row.current],
  ].filter(([, v]) => (v as number) > 0) as Array<[string, number]>;
  if (parts.length === 0) return <span className="mgr-muted">—</span>;
  return (
    <ul className="mgr-aging-lines">
      {parts.map(([label, value]) => (
        <li key={label}>
          <span className="mgr-muted">{label}</span> {money(value, false)}
        </li>
      ))}
    </ul>
  );
}

function Collections({ rows, aging }: { rows: CollectionRow[]; aging: Parameters<typeof AgingBar>[0]["aging"] & { accounts: number } }) {
  const { go, open, can } = useManager();
  const [band, setBand] = useState<LateBand>("all");
  const [property, setProperty] = useState("");
  const [search, setSearch] = useState("");
  const properties = [...new Map(rows.map((r) => [r.propertyId, r.propertyName])).entries()];
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (band === "all" || bandOf(r) === band) &&
          (!property || String(r.propertyId) === property) &&
          (!q || r.unitLabel.toLowerCase().includes(q) || r.tenants.some((t) => t.name.toLowerCase().includes(q) || t.email.includes(q))),
      ),
    [rows, band, property, q],
  );
  const sorter = useSort("collections", filtered, {
    unit: (r) => r.unitLabel,
    owed: (r) => r.total,
    // Oldest money first: weight each bucket by how late it is.
    oldest: (r) => r.d90plus * 1e9 + r.d61_90 * 1e6 + r.d31_60 * 1e3 + r.d1_30,
    late: (r) => r.daysLate,
    behind: (r) => r.monthsBehind,
    last: (r) => r.lastPayment?.paidAt ?? null,
    contact: (r) => r.lastContactAt,
  }, { key: "late", dir: "desc" });
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [bandOf(r)]: (acc[bandOf(r)] ?? 0) + 1 }), {});
  const bands: Array<[LateBand, string]> = [
    ["all", "Everyone owing"],
    ["current", "Not late yet"],
    ["1-30", "1–30 days"],
    ["31-60", "31–60"],
    ["61-90", "61–90"],
    ["90+", "90+"],
  ];
  const totalShown = filtered.reduce((s, r) => s + r.total, 0);

  function exportCsv() {
    downloadCsv(`collections-${todayIso()}.csv`, [
      ["Unit", "Property", "Residents", "Phone", "Email", "Owed", "Not late", "1-30", "31-60", "61-90", "90+", "Days late", "Months behind", "Oldest unpaid due", "Last payment", "Last payment date", "Late fees billed", "Last contacted"],
      ...sorter.rows.map((r) => [
        r.unitLabel,
        r.propertyName,
        r.tenants.map((t) => t.name).join("; "),
        r.tenants.map((t) => t.phone ?? "").filter(Boolean).join("; "),
        r.tenants.map((t) => t.email).join("; "),
        r.total.toFixed(2),
        r.current.toFixed(2),
        r.d1_30.toFixed(2),
        r.d31_60.toFixed(2),
        r.d61_90.toFixed(2),
        r.d90plus.toFixed(2),
        r.daysLate,
        r.monthsBehind,
        r.oldestUnpaidDue ?? "",
        r.lastPayment ? r.lastPayment.amount.toFixed(2) : "",
        r.lastPayment ? r.lastPayment.paidAt.slice(0, 10) : "",
        r.lateFeesBilled.toFixed(2),
        r.lastContactAt ? r.lastContactAt.slice(0, 10) : "never",
      ]),
    ]);
  }

  return (
    <section className="mgr-card" aria-labelledby="fin-collections-h" id="fin-collections">
      <div className="mgr-card__head">
        <h2 className="mgr-h2">
          <span id="fin-collections-h">Collections</span> <span className="mgr-muted mgr-h2__sub">· who owes, how much, and for how long</span>
        </h2>
        <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>
      <AgingBar aging={aging} />
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="How late">
          {bands.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={band === value} className={`mgr-tab${band === value ? " mgr-tab--active" : ""}`} onClick={() => setBand(value)}>
              {label} <span className="mgr-tab__count">{value === "all" ? rows.length : counts[value] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="mgr-toolbar__filters">
          {properties.length > 1 && (
            <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)}>
              <option value="">All properties</option>
              {properties.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <input type="search" aria-label="Search unit or resident" placeholder="Search unit or resident" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>Nobody owes anything. Every account is paid up.</Empty>
      ) : sorter.rows.length === 0 ? (
        <Empty>No accounts match.</Empty>
      ) : (
        <div className="mgr-table-wrap">
          <table className="mgr-table mgr-table--collections">
            <thead>
              <tr>
                <SortTh sorter={sorter} k="unit">Unit</SortTh>
                <th scope="col">Residents &amp; contact</th>
                <SortTh sorter={sorter} k="owed" num>Owed</SortTh>
                <SortTh sorter={sorter} k="oldest" num>Aging</SortTh>
                <SortTh sorter={sorter} k="late" num>Days late</SortTh>
                <SortTh sorter={sorter} k="last">Last paid / contacted</SortTh>
                <th scope="col"><span className="mgr-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sorter.rows.map((r) => (
                <tr key={r.leaseId} className={r.daysLate > 30 ? "mgr-row--alert" : undefined}>
                  <th scope="row">
                    {r.unitLabel}
                    <div className="mgr-muted">{r.propertyName}</div>
                    {r.ended && <span className="mgr-badge">Moved out</span>}
                  </th>
                  <td>
                    <Contact tenants={r.tenants} />
                  </td>
                  <td className="mgr-num mgr-owes">
                    <strong>{money(r.total)}</strong>
                    {r.monthsBehind >= 1 && <div className="mgr-muted">{r.monthsBehind.toFixed(1).replace(".0", "")} mo. rent</div>}
                  </td>
                  <td className="mgr-num">
                    <AgingLines row={r} />
                  </td>
                  <td className="mgr-num">
                    {r.daysLate > 0 ? <span className={`mgr-pill mgr-pill--${r.daysLate > 30 ? "late" : "partial"}`}>{r.daysLate} days</span> : <span className="mgr-muted">Not late</span>}
                    {r.oldestUnpaidDue && <div className="mgr-muted">since {isoDate(r.oldestUnpaidDue)}</div>}
                  </td>
                  <td>
                    {r.lastPayment ? (
                      <div>
                        Paid {money(r.lastPayment.amount)} <span className="mgr-muted">{timeAgo(r.lastPayment.paidAt)}</span>
                      </div>
                    ) : (
                      <div className="mgr-muted">No payments yet</div>
                    )}
                    <div>
                      Contacted {r.lastContactAt ? <span className="mgr-muted">{timeAgo(r.lastContactAt)}</span> : <span className="mgr-owes">never</span>}
                    </div>
                    {r.lateFeesBilled > 0 && <div className="mgr-muted">{money(r.lateFeesBilled)} late fees billed</div>}
                  </td>
                  <td className="mgr-row-actions mgr-row-actions--grid">
                    <div className="mgr-actions-grid">
                    {can("ledger:adjust") && (
                      <button type="button" className="mgr-btn mgr-btn--primary mgr-btn--small" aria-label={`Record a payment for ${r.unitLabel}`} onClick={() => open({ kind: "payment", leaseId: r.leaseId })}>
                        + Payment
                      </button>
                    )}
                    {can("messages:manage") && r.tenants[0] && (
                      <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => go({ name: "messages", tenantId: r.tenants[0]!.id })}>
                        Message
                      </button>
                    )}
                    {can("ledger:adjust") && r.daysLate > 0 && (
                      <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => open({ kind: "charge", leaseId: r.leaseId, label: r.unitLabel })}>
                        Late fee
                      </button>
                    )}
                    <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "lease", id: r.leaseId })}>
                      Lease
                    </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mgr-table-foot">
        {sorter.rows.length} account{sorter.rows.length === 1 ? "" : "s"} · <span className="mgr-owes">{money(totalShown)} owed</span> · Payments go to the oldest charge first.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Cash App / Zelle payments tenants reported (Juan's tenant side, 006)
 * ------------------------------------------------------------------ */

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Payments a tenant says they sent: they count once the office confirms the money arrived. */
function ReportedPayments() {
  const { open, can } = useManager();
  const { data, error } = useLoad(() => financeApi.reported("pending"));
  if (error) return null; // the rest of Finance still works
  if (!data || data.length === 0) return null;
  return (
    <section className="mgr-card mgr-card--attention" aria-labelledby="fin-reported">
      <div className="mgr-card__head">
        <h2 className="mgr-h2" id="fin-reported">
          Awaiting confirmation <span className="mgr-tab__count">{data.length}</span>
        </h2>
      </div>
      <p className="mgr-muted">
        Tenants paid with Cash App or Zelle and told the portal. Check the office's account, then confirm it (it counts on their ledger) or reject it with a reason
        (they're messaged).
      </p>
      <div className="mgr-table-wrap">
        <table className="mgr-table">
          <thead>
            <tr>
              <th scope="col">Reported</th>
              <th scope="col">Tenant</th>
              <th scope="col">Unit</th>
              <th scope="col">Method</th>
              <th scope="col" className="mgr-num">Amount</th>
              <th scope="col">Memo to look for</th>
              {can("ledger:adjust") && <th scope="col">Decision</th>}
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <ReportedRow key={r.id} row={r} canDecide={can("ledger:adjust")} onReject={() => open({ kind: "rejectReport", payId: r.id, label: `${r.tenantName}'s ${MANUAL_PAY_LABELS[r.method]} payment of ${money(r.amount)}` })} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportedRow({ row: r, canDecide, onReject }: { row: ReportedPaymentRow; canDecide: boolean; onReject: () => void }) {
  const { open } = useManager();
  return (
    <tr>
      <td>
        {fmtDateTime(r.reportedAt)}
        <div className="mgr-muted">{timeAgo(r.reportedAt)}</div>
      </td>
      <th scope="row">{r.tenantName}</th>
      <td>
        {r.unitLabel}
        <div className="mgr-muted">{r.propertyName}</div>
      </td>
      <td>{MANUAL_PAY_LABELS[r.method]}</td>
      <td className="mgr-num">
        {money(r.amount)}
        <div className="mgr-muted">Balance {money(r.balance)}</div>
      </td>
      <td className="mgr-muted">
        {/* The same text the tenant was told to put in the memo (PayRentPage). */}
        {r.unitLabel} - {r.propertyName} - {r.tenantName}
      </td>
      {canDecide && (
        <td>
          <div className="mgr-row-actions">
            <button
              type="button"
              className="mgr-btn mgr-btn--primary mgr-btn--small"
              onClick={() =>
                open({
                  kind: "confirm",
                  title: "Confirm payment",
                  body: `Did ${money(r.amount)} from ${r.tenantName} arrive in the office's ${MANUAL_PAY_LABELS[r.method]}? Confirming puts it on their ledger and lowers the balance. They get a message saying it was received.`,
                  confirmLabel: "Yes, it arrived",
                  run: () => financeApi.confirmReport(r.id),
                  done: `${r.tenantName}'s payment is on their ledger.`,
                })
              }
            >
              Confirm
            </button>
            <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={onReject}>
              Reject
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

export function RejectReportDialog({ payId, label, onClose }: DialogProps<"rejectReport">) {
  const { changed } = useManager();
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Rejected. The tenant has a message with your reason.");
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(
      async () => {
        if (!reason.trim()) throw new LocalError("Say why, so the tenant knows what to check.");
        await financeApi.rejectReport(payId, reason.trim());
      },
      { NOT_FOUND: "Someone already decided this payment. Refresh to see it." },
    );
  }
  return (
    <Modal title="Reject payment" onClose={onClose}>
      <form className="mgr-form" onSubmit={submit}>
        <p className="mgr-muted" style={{ marginTop: 0 }}>
          {label}. It stays off their ledger, and they're sent this reason.
        </p>
        <Field label="Reason">
          <input maxLength={300} placeholder="No payment with that memo arrived" value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
        </Field>
        <ErrorText error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : "Reject payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Payment options: the office's Cash App and Zelle (shown to tenants)
 * ------------------------------------------------------------------ */

export function PaymentOptionsPage() {
  const { can, changed } = useManager();
  const { data, error } = useLoad(() => financeApi.settings());
  const history = useLoad(() => financeApi.reported("all"));
  const [cashapp, setCashapp] = useState<string | null>(null);
  const [zelle, setZelle] = useState<string | null>(null);
  const editable = can("users:provision");
  const cashappValue = cashapp ?? data?.cashappHandle ?? "";
  const zelleValue = zelle ?? data?.zelleHandle ?? "";
  const { busy, error: saveError, run } = useSubmit(() => {
    setCashapp(null);
    setZelle(null);
    changed("Saved. Tenants see these on Pay rent now.");
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const tag = cashappValue.trim();
      const z = zelleValue.trim();
      if (tag && !/^\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag)) throw new LocalError("A $cashtag starts with $ and a letter, like $SummitPM.");
      if (z && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(z) && z.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length !== 10) {
        throw new LocalError("Zelle needs the email address or 10-digit phone number the office's Zelle uses.");
      }
      await financeApi.saveSettings({ cashappHandle: tag || null, zelleHandle: z || null });
    });
  }

  const decided = (history.data ?? []).filter((r) => r.status !== "pending").slice(0, 10);
  return (
    <>
      <PageHeader title="Payment options" subtitle="Where tenants can send rent besides their bank account." />
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <section className="mgr-card" aria-labelledby="po-handles">
            <h2 className="mgr-h2" id="po-handles">Cash App &amp; Zelle</h2>
            <p className="mgr-muted">
              Tenants see these on Pay rent with their memo (unit and name). Their payment waits under Finance → Awaiting confirmation until someone checks the
              account and confirms it. Leave one empty to stop offering it.
            </p>
            <form className="mgr-form" onSubmit={submit}>
              <div className="mgr-form__row">
                <Field label="Cash App $cashtag" hint="Like $SummitPM">
                  <input maxLength={21} placeholder="$SummitPM" value={cashappValue} onChange={(e) => setCashapp(e.target.value)} disabled={!editable} />
                </Field>
                <Field label="Zelle email or phone" hint="What the office's Zelle is enrolled with">
                  <input maxLength={120} placeholder="payments@yourcompany.com" value={zelleValue} onChange={(e) => setZelle(e.target.value)} disabled={!editable} />
                </Field>
              </div>
              <ErrorText error={saveError} />
              {editable ? (
                <div className="mgr-modal__actions">
                  <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy || (cashapp === null && zelle === null)}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              ) : (
                <p className="mgr-muted">Only a property manager can change these.</p>
              )}
              {data.updatedBy && data.updatedAt && (
                <p className="mgr-muted">
                  Last changed by {data.updatedBy}, {timeAgo(data.updatedAt)}.
                </p>
              )}
            </form>
          </section>
          <section className="mgr-card" aria-labelledby="po-history">
            <h2 className="mgr-h2" id="po-history">Recent decisions</h2>
            {decided.length === 0 ? (
              <Empty>No Cash App or Zelle payments have been confirmed or rejected yet.</Empty>
            ) : (
              <div className="mgr-table-wrap">
                <table className="mgr-table">
                  <thead>
                    <tr>
                      <th scope="col">Reported</th>
                      <th scope="col">Tenant</th>
                      <th scope="col">Method</th>
                      <th scope="col" className="mgr-num">Amount</th>
                      <th scope="col">Decision</th>
                      <th scope="col">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decided.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDateTime(r.reportedAt)}</td>
                        <th scope="row">
                          {r.tenantName}
                          <div className="mgr-muted">{r.unitLabel}</div>
                        </th>
                        <td>{MANUAL_PAY_LABELS[r.method]}</td>
                        <td className="mgr-num">{money(r.amount)}</td>
                        <td>
                          <span className={`mgr-pill mgr-pill--${r.status === "confirmed" ? "paid" : "late"}`}>{r.status === "confirmed" ? "Confirmed" : "Rejected"}</span>
                          {r.reason && <div className="mgr-muted">{r.reason}</div>}
                        </td>
                        <td className="mgr-muted">
                          {r.reviewedBy ?? "—"}
                          {r.reviewedAt && <div>{timeAgo(r.reviewedAt)}</div>}
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

function RecentPayments({ rows }: { rows: RecentPaymentRow[] }) {
  const { go } = useManager();
  const [status, setStatus] = useState<"all" | RecentPaymentRow["status"]>("all");
  const [showAll, setShowAll] = useState(false);
  const SHOWN = 12;
  const filtered = useMemo(() => rows.filter((r) => status === "all" || r.status === status), [rows, status]);
  const sorter = useSort("recent-payments", filtered, {
    date: (r) => r.paidAt,
    payer: (r) => r.payer,
    unit: (r) => r.unitLabel,
    amount: (r) => r.amount,
    status: (r) => r.status,
    due: (r) => r.forCharge?.dueDate ?? null,
  }, { key: "date", dir: "desc" });
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return (
    <section className="mgr-card" aria-labelledby="fin-recent">
      <div className="mgr-card__head">
        <h2 className="mgr-h2" id="fin-recent">Recent payments</h2>
        <div className="mgr-tabs" role="tablist" aria-label="Payment status">
          {(["all", "paid", "partial", "prepaid", "refund"] as const).map((s) =>
            s === "all" || counts[s] ? (
              <button key={s} type="button" role="tab" aria-selected={status === s} className={`mgr-tab${status === s ? " mgr-tab--active" : ""}`} onClick={() => setStatus(s)}>
                {s === "all" ? "All" : PAYMENT_STATUS[s]} <span className="mgr-tab__count">{s === "all" ? rows.length : counts[s]}</span>
              </button>
            ) : null,
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>No payments yet.</Empty>
      ) : (
        <div className="mgr-table-wrap">
          <table className="mgr-table">
            <thead>
              <tr>
                <SortTh sorter={sorter} k="date">Paid</SortTh>
                <SortTh sorter={sorter} k="payer">Payer</SortTh>
                <SortTh sorter={sorter} k="unit">Unit</SortTh>
                <SortTh sorter={sorter} k="amount" num>Amount</SortTh>
                <SortTh sorter={sorter} k="status">Status</SortTh>
                <SortTh sorter={sorter} k="due">For charge due</SortTh>
                <th scope="col">Method</th>
                <th scope="col">Confirmation</th>
              </tr>
            </thead>
            <tbody>
              {(showAll ? sorter.rows : sorter.rows.slice(0, SHOWN)).map((r) => (
                <tr key={r.id}>
                  <td>
                    {new Date(r.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    <div className="mgr-muted">{timeAgo(r.paidAt)}</div>
                  </td>
                  <th scope="row">{r.payer}</th>
                  <td>
                    <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "lease", id: r.leaseId })}>
                      {r.unitLabel}
                    </button>
                    <div className="mgr-muted">{r.propertyName}</div>
                  </td>
                  <td className={`mgr-num${r.status === "refund" ? " mgr-owes" : ""}`}>
                    {r.status === "refund" ? `−${money(r.amount)}` : money(r.amount)}
                    {r.ahead > 0 && r.status !== "prepaid" && <div className="mgr-muted">{money(r.ahead)} paid ahead</div>}
                  </td>
                  <td>
                    <span className={`mgr-pill mgr-pill--${r.status}`}>{PAYMENT_STATUS[r.status]}</span>
                  </td>
                  <td>{r.forCharge ? `${CHARGE_LABELS[r.forCharge.kind] ?? r.forCharge.kind} due ${isoDate(r.forCharge.dueDate)}` : <span className="mgr-muted">{r.status === "prepaid" ? "Held as credit" : "—"}</span>}</td>
                  <td className="mgr-muted">{r.method ?? "—"}</td>
                  <td className="mgr-mono">{r.confirmation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sorter.rows.length > SHOWN && (
        <p className="mgr-table-foot">
          {showAll ? `All ${sorter.rows.length} payments` : `Latest ${SHOWN} of ${sorter.rows.length}`} ·{" "}
          <button type="button" className="mgr-btn mgr-btn--link" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${sorter.rows.length}`}
          </button>
        </p>
      )}
    </section>
  );
}

function ExpenseList({ rows, periodLabel }: { rows: Array<import("./finance-api").ExpenseRow>; periodLabel: string }) {
  const { open, can } = useManager();
  const sorter = useSort("expenses", rows, {
    date: (r) => r.spentOn,
    category: (r) => expenseLabel(r.category),
    where: (r) => r.propertyName ?? "Portfolio",
    vendor: (r) => r.vendor,
    amount: (r) => r.amount,
  }, { key: "date", dir: "desc" });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <section className="mgr-card" aria-labelledby="fin-expenses">
      <div className="mgr-card__head">
        <h2 className="mgr-h2" id="fin-expenses">
          Expenses <span className="mgr-muted mgr-h2__sub">· {periodLabel}</span>
        </h2>
        {can("ledger:adjust") && (
          <button type="button" className="mgr-btn mgr-btn--secondary mgr-btn--small" onClick={() => open({ kind: "expense" })}>
            + Add expense
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>No expenses logged for this period.</Empty>
      ) : (
        <div className="mgr-table-wrap">
          <table className="mgr-table">
            <thead>
              <tr>
                <SortTh sorter={sorter} k="date">Date</SortTh>
                <SortTh sorter={sorter} k="category">Category</SortTh>
                <SortTh sorter={sorter} k="where">Property / unit</SortTh>
                <SortTh sorter={sorter} k="vendor">Vendor &amp; note</SortTh>
                <SortTh sorter={sorter} k="amount" num>Amount</SortTh>
                <th scope="col"><span className="mgr-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sorter.rows.map((e) => (
                <tr key={e.id}>
                  <td>{isoDate(e.spentOn)}</td>
                  <td>{expenseLabel(e.category)}</td>
                  <td>
                    {e.propertyName ?? <span className="mgr-muted">Whole portfolio</span>}
                    {e.unitNum && <div className="mgr-muted">Unit {e.unitNum}</div>}
                  </td>
                  <td>
                    {e.vendor ?? <span className="mgr-muted">—</span>}
                    {e.description && <div className="mgr-muted">{e.description}</div>}
                  </td>
                  <td className="mgr-num">{money(e.amount)}</td>
                  <td className="mgr-row-actions">
                    {can("ledger:adjust") && (
                      <button
                        type="button"
                        className="mgr-btn mgr-btn--danger-ghost mgr-btn--small"
                        onClick={() =>
                          open({
                            kind: "confirm",
                            title: "Void expense",
                            body: `Void the ${money(e.amount)} ${expenseLabel(e.category).toLowerCase()} expense from ${isoDate(e.spentOn)}? It drops out of Profit & Loss but stays on record.`,
                            confirmLabel: "Void expense",
                            run: () => financeApi.voidExpense(e.id),
                            done: "Expense voided.",
                          })
                        }
                      >
                        Void
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
        {rows.length} expense{rows.length === 1 ? "" : "s"} · {money(total)}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Profit & Loss
 * ------------------------------------------------------------------ */

export function ProfitLossPage({ period }: { period: FinancePeriod }) {
  const { go } = useManager();
  const { data, error } = useLoad(() => financeApi.overview(period), [period]);
  const byProperty = useSort("pnl-properties", data?.pnl.byProperty ?? [], {
    name: (r) => r.name,
    billed: (r) => r.billed,
    collected: (r) => r.collected,
    expenses: (r) => r.expenses,
    net: (r) => r.net,
    margin: (r) => (r.collected > 0 ? r.net / r.collected : null),
  }, { key: "net", dir: "desc" });

  if (!data) {
    return (
      <>
        <PageHeader title="Profit & Loss" subtitle="Income, expenses and what is left." actions={<PeriodPicker value={period} onChange={(p) => go({ name: "pnl", period: p })} />} />
        <Loading error={error} />
      </>
    );
  }
  const p = data.pnl;

  function exportCsv() {
    downloadCsv(`profit-and-loss-${data!.period.from}-to-${data!.period.to}.csv`, [
      ["Profit & Loss", `${data!.period.label} (${data!.period.from} to ${data!.period.to})`],
      [],
      ["Income", "Billed", "Collected"],
      ...p.income.map((l) => [l.label, l.billed.toFixed(2), l.collected.toFixed(2)]),
      ["Paid ahead (credit)", "", p.prepaid.toFixed(2)],
      ["Refunds and reversals", "", p.refunds.toFixed(2)],
      ["Total income", p.totalBilled.toFixed(2), p.totalCollected.toFixed(2)],
      [],
      ["Operating expenses", "", "Amount"],
      ...p.expenses.map((e) => [e.label, "", e.amount.toFixed(2)]),
      ["Total operating expenses", "", p.totalExpenses.toFixed(2)],
      [],
      ["Net operating income", "", p.netOperatingIncome.toFixed(2)],
      ["Operating margin", "", `${Math.round(p.margin * 100)}%`],
      [],
      ["By property", "Billed", "Collected", "Expenses", "Net"],
      ...p.byProperty.map((r) => [r.name, r.billed.toFixed(2), r.collected.toFixed(2), r.expenses.toFixed(2), r.net.toFixed(2)]),
    ]);
  }

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        subtitle={`${data.period.label} · ${isoDate(data.period.from)} – ${isoDate(data.period.to)} · cash basis`}
        actions={
          <>
            <PeriodPicker value={period} onChange={(next) => go({ name: "pnl", period: next })} />
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={exportCsv}>
              Export CSV
            </button>
            <button type="button" className="mgr-btn mgr-btn--ghost" onClick={() => window.print()}>
              Print
            </button>
          </>
        }
      />
      <div className="mgr-pnl-hero">
        <div className="mgr-pnl-hero__main">
          <span className="mgr-kpi__label">Net operating income</span>
          <span className={`mgr-pnl-hero__value${p.netOperatingIncome < 0 ? " mgr-owes" : ""}`}>{money(p.netOperatingIncome)}</span>
          <span className="mgr-muted">
            {pct(p.margin)} operating margin · {money(p.totalCollected)} in − {money(p.totalExpenses)} out
          </span>
        </div>
        <Kpi label="Total income" value={money(p.totalCollected, false)} note={`${money(p.totalBilled, false)} billed · ${p.totalBilled > 0 ? pct(Math.min(1, p.totalCollected / p.totalBilled)) : "—"} collected`} tone="good" />
        <Kpi label="Operating expenses" value={money(p.totalExpenses, false)} note={p.totalCollected > 0 ? `${pct(p.totalExpenses / p.totalCollected)} of income` : "No income yet"} />
        <Kpi label="Still owed" value={money(data.aging.total, false)} note="Not in income until it is paid" tone={data.aging.total > 0 ? "warn" : undefined} onClick={() => go({ name: "finance", period })} />
      </div>

      <div className="mgr-columns mgr-columns--pnl">
        <section className="mgr-card mgr-statement" aria-labelledby="pnl-statement">
          <h2 className="mgr-h2" id="pnl-statement">Statement</h2>
          <div className="mgr-table-wrap">
          <table className="mgr-table mgr-table--statement">
            <thead>
              <tr>
                <th scope="col">Income</th>
                <th scope="col" className="mgr-num">Billed</th>
                <th scope="col" className="mgr-num">Collected</th>
                <th scope="col" className="mgr-num">% collected</th>
              </tr>
            </thead>
            <tbody>
              {p.income.map((l) => (
                <tr key={l.category}>
                  <th scope="row">{l.label}</th>
                  <td className="mgr-num">{money(l.billed)}</td>
                  <td className="mgr-num">{money(l.collected)}</td>
                  <td className="mgr-num mgr-muted">{l.billed > 0 ? pct(Math.min(1, l.collected / l.billed)) : "—"}</td>
                </tr>
              ))}
              {p.prepaid !== 0 && (
                <tr>
                  <th scope="row">
                    Paid ahead <span className="mgr-muted">(held as credit)</span>
                  </th>
                  <td className="mgr-num">—</td>
                  <td className="mgr-num">{money(p.prepaid)}</td>
                  <td />
                </tr>
              )}
              {p.refunds !== 0 && (
                <tr>
                  <th scope="row">Refunds &amp; reversals</th>
                  <td className="mgr-num">—</td>
                  <td className="mgr-num mgr-owes">{money(p.refunds)}</td>
                  <td />
                </tr>
              )}
              <tr className="mgr-statement__total">
                <th scope="row">Total income</th>
                <td className="mgr-num">{money(p.totalBilled)}</td>
                <td className="mgr-num">{money(p.totalCollected)}</td>
                <td className="mgr-num">{p.totalBilled > 0 ? pct(Math.min(1, p.totalCollected / p.totalBilled)) : "—"}</td>
              </tr>
            </tbody>
            <tbody>
              <tr className="mgr-statement__section">
                <th scope="col">Operating expenses</th>
                <td />
                <td className="mgr-num mgr-muted">Amount</td>
                <td className="mgr-num mgr-muted">% of income</td>
              </tr>
              {p.expenses.length === 0 && (
                <tr>
                  <td colSpan={4} className="mgr-muted">
                    No expenses logged for this period.
                  </td>
                </tr>
              )}
              {p.expenses.map((e) => (
                <tr key={e.category}>
                  <th scope="row">{e.label}</th>
                  <td data-label="" />
                  <td className="mgr-num" data-label="Amount">{money(e.amount)}</td>
                  <td className="mgr-num mgr-muted" data-label="% of income">{p.totalCollected > 0 ? pct(e.amount / p.totalCollected) : "—"}</td>
                </tr>
              ))}
              <tr className="mgr-statement__total">
                <th scope="row">Total operating expenses</th>
                <td data-label="" />
                <td className="mgr-num" data-label="Amount">{money(p.totalExpenses)}</td>
                <td className="mgr-num" data-label="% of income">{p.totalCollected > 0 ? pct(p.totalExpenses / p.totalCollected) : "—"}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="mgr-statement__net">
                <th scope="row">Net operating income</th>
                <td data-label="" />
                <td className={`mgr-num${p.netOperatingIncome < 0 ? " mgr-owes" : ""}`} data-label="Amount">{money(p.netOperatingIncome)}</td>
                <td className="mgr-num" data-label="Margin">{pct(p.margin)}</td>
              </tr>
            </tfoot>
          </table>
          </div>
          <p className="mgr-field__hint">
            Cash basis: income counts when the money arrives, so a month's rent paid late shows in the month it was paid. "Billed" shows what was charged in the same period, for comparison. Refunds and undone payments come off income.
          </p>
        </section>
        <section className="mgr-card" aria-labelledby="pnl-where">
          <h2 className="mgr-h2" id="pnl-where">Where the money went</h2>
          {p.expenses.length === 0 ? (
            <Empty>No expenses yet.</Empty>
          ) : (
            <HBars color={SERIES.expense} total={p.totalExpenses} rows={[...p.expenses].sort((a, b) => b.amount - a.amount).map((e) => ({ label: e.label, value: e.amount }))} />
          )}
          <h3 className="mgr-h3">Where it came from</h3>
          <HBars color={SERIES.income} total={p.totalCollected} rows={p.income.filter((l) => l.collected > 0).map((l) => ({ label: l.label, value: l.collected }))} />
        </section>
      </div>

      <section className="mgr-card" aria-labelledby="pnl-trend">
        <h2 className="mgr-h2" id="pnl-trend">Monthly income vs expenses</h2>
        <p className="mgr-muted">Last 12 months, whatever period is picked above.</p>
        <IncomeExpenseChart months={data.monthly.map((m) => ({ label: m.label, income: m.collected, expenses: m.expenses, net: m.net, billed: m.billed }))} />
        <MonthTable months={data.monthly} />
      </section>

      <section className="mgr-card" aria-labelledby="pnl-props">
        <h2 className="mgr-h2" id="pnl-props">By property</h2>
        <div className="mgr-table-wrap">
          <table className="mgr-table">
            <thead>
              <tr>
                <SortTh sorter={byProperty} k="name">Property</SortTh>
                <SortTh sorter={byProperty} k="billed" num>Billed</SortTh>
                <SortTh sorter={byProperty} k="collected" num>Collected</SortTh>
                <SortTh sorter={byProperty} k="expenses" num>Expenses</SortTh>
                <SortTh sorter={byProperty} k="net" num>Net</SortTh>
                <SortTh sorter={byProperty} k="margin" num>Margin</SortTh>
              </tr>
            </thead>
            <tbody>
              {byProperty.rows.map((r) => (
                <tr key={r.propertyId ?? "portfolio"} className={r.propertyId === null ? "mgr-row--muted" : undefined}>
                  <th scope="row">
                    {r.propertyId ? (
                      <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "property", id: r.propertyId! })}>
                        {r.name}
                      </button>
                    ) : (
                      r.name
                    )}
                  </th>
                  <td className="mgr-num">{money(r.billed)}</td>
                  <td className="mgr-num">{money(r.collected)}</td>
                  <td className="mgr-num">{money(r.expenses)}</td>
                  <td className={`mgr-num${r.net < 0 ? " mgr-owes" : ""}`}>
                    <strong>{money(r.net)}</strong>
                  </td>
                  <td className="mgr-num">{r.collected > 0 ? pct(r.net / r.collected) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="mgr-statement__total">
                <th scope="row">Total</th>
                <td className="mgr-num">{money(p.totalBilled)}</td>
                <td className="mgr-num">{money(p.totalCollected)}</td>
                <td className="mgr-num">{money(p.totalExpenses)}</td>
                <td className="mgr-num">
                  <strong>{money(p.netOperatingIncome)}</strong>
                </td>
                <td className="mgr-num">{pct(p.margin)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mgr-field__hint">"Portfolio-wide" holds costs not tied to one building, such as software and the umbrella policy.</p>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------ */

export function PerformancePage() {
  const { go } = useManager();
  const { data, error } = useLoad(() => financeApi.analytics());
  const props = useSort("performance", data?.properties ?? [], {
    name: (r) => r.name,
    units: (r) => r.units,
    occupancy: (r) => r.occupancy,
    rentRoll: (r) => r.rentRoll,
    avgRent: (r) => r.avgRent,
    collected: (r) => r.collected12m,
    rate: (r) => r.collectionRate,
    expenses: (r) => r.expenses12m,
    noi: (r) => r.noi12m,
    noiUnit: (r) => (r.units ? r.noi12m / r.units : 0),
    outstanding: (r) => r.outstanding,
    maintenance: (r) => r.openMaintenance,
    expiring: (r) => r.expiring90,
  }, { key: "noi", dir: "desc" });

  if (!data) {
    return (
      <>
        <PageHeader title="Performance" subtitle="How the portfolio is doing over the last 12 months." />
        <Loading error={error} />
      </>
    );
  }
  const k = data.kpis;
  const insights = performanceInsights(data);

  return (
    <>
      <PageHeader
        title="Performance"
        subtitle={`How the portfolio is doing over the last 12 months · as of ${isoDate(data.asOf)}`}
        actions={
          <button
            type="button"
            className="mgr-btn mgr-btn--ghost"
            onClick={() =>
              downloadCsv(`performance-${data.asOf}.csv`, [
                ["Property", "Units", "Occupied", "Occupancy", "Monthly rent roll", "Avg rent", "Billed 12m", "Collected 12m", "Collection rate", "Expenses 12m", "NOI 12m", "Outstanding", "Open maintenance", "Leases ending in 90 days"],
                ...data.properties.map((r) => [r.name, r.units, r.occupied, pct(r.occupancy), r.rentRoll.toFixed(2), r.avgRent.toFixed(2), r.billed12m.toFixed(2), r.collected12m.toFixed(2), pct(r.collectionRate), r.expenses12m.toFixed(2), r.noi12m.toFixed(2), r.outstanding.toFixed(2), r.openMaintenance, r.expiring90]),
              ])
            }
          >
            Export CSV
          </button>
        }
      />
      <h2 className="mgr-section-title">Occupancy &amp; rent</h2>
      <div className="mgr-kpis">
        <Kpi label="Occupancy" value={pct(k.occupancy)} note={`${k.occupied} of ${k.units} units leased · ${k.vacant} vacant`} tone={k.occupancy >= 0.9 ? "good" : "warn"} onClick={() => go({ name: "rent-roll", filter: "vacant" })} />
        <Kpi label="Monthly rent roll" value={money(k.rentRoll, false)} note={`${money(k.avgRent, false)} average rent`} />
        <Kpi label="Vacancy cost" value={money(k.vacant * k.avgRent, false)} note="A month of rent at the average, per vacant unit" tone={k.vacant > 0 ? "warn" : undefined} />
        <Kpi label="Leases ending in 90 days" value={String(k.expiring90)} note="Reach out about renewing" tone={k.expiring90 > 0 ? "warn" : undefined} onClick={() => go({ name: "renewals", days: 90 })} />
      </div>
      <h2 className="mgr-section-title">Collections</h2>
      <div className="mgr-kpis">
        <Kpi label="Collection rate" value={pct(k.collectionRate12m)} note={`${money(k.collected12m, false)} of ${money(k.billed12m, false)} billed`} tone={k.collectionRate12m >= 0.95 ? "good" : "warn"} />
        <Kpi label="Paid on time" value={pct(k.onTimeRate)} note={data.lateAfterDays ? `Within ${data.lateAfterDays} days of the due date` : "By the due date"} tone={k.onTimeRate >= 0.8 ? "good" : "warn"} />
        <Kpi label="Average days to pay" value={k.avgDaysToPay.toFixed(1)} note="From due date to paid in full" />
        <Kpi label="Delinquency" value={pct(k.delinquencyRate)} note={`${money(k.outstanding, false)} owed vs. one month's rent roll`} tone={k.delinquencyRate > 0.1 ? "warn" : undefined} onClick={() => go({ name: "finance", period: "this-month" })} />
      </div>
      <h2 className="mgr-section-title">Profit &amp; operations</h2>
      <div className="mgr-kpis">
        <Kpi label="Net operating income" value={money(k.noi12m, false)} note={`${money(k.collected12m, false)} in − ${money(k.expenses12m, false)} out`} tone={k.noi12m >= 0 ? "good" : "warn"} onClick={() => go({ name: "pnl", period: "12m" })} />
        <Kpi label="NOI per unit" value={money(k.units ? k.noi12m / k.units : 0, false)} note="Last 12 months" />
        <Kpi label="Expense ratio" value={k.collected12m > 0 ? pct(k.expenses12m / k.collected12m) : "—"} note="Expenses as a share of income" />
        <Kpi label="Open maintenance" value={String(k.openMaintenance)} note={k.avgResolutionDays === null ? "No requests resolved yet" : `${k.avgResolutionDays.toFixed(1)} days to resolve, on average`} onClick={() => go({ name: "maintenance" })} />
      </div>

      {insights.length > 0 && (
        <section className="mgr-card" aria-labelledby="perf-insights">
          <h2 className="mgr-h2" id="perf-insights">What stands out</h2>
          <ul className="mgr-insights">
            {insights.map((i, n) => (
              <li key={n} className={`mgr-insight mgr-insight--${i.tone}`}>
                <span className="mgr-insight__tag">{i.tone === "warn" ? "Watch" : i.tone === "good" ? "Good" : "Note"}</span>
                {i.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mgr-columns">
        <section className="mgr-card" aria-labelledby="perf-rates">
          <h2 className="mgr-h2" id="perf-rates">Collection rate &amp; occupancy</h2>
          <p className="mgr-muted">Collection rate: share of each month's charges paid so far. Occupancy: leased units at month end.</p>
          <PercentLines
            labels={data.trend.map((t) => t.label)}
            series={[
              { name: "Collection rate", color: SERIES.income, values: data.trend.map((t) => t.collectionRate) },
              { name: "Occupancy", color: SERIES.expense, values: data.trend.map((t) => t.occupancy) },
            ]}
          />
        </section>
        <section className="mgr-card" aria-labelledby="perf-noi">
          <h2 className="mgr-h2" id="perf-noi">Income, expenses &amp; NOI</h2>
          <p className="mgr-muted">Monthly, last 12 months.</p>
          <IncomeExpenseChart height={250} months={data.trend.map((t) => ({ label: t.label, income: t.collected, expenses: t.expenses, net: t.noi, billed: t.billed }))} />
        </section>
      </div>

      <section className="mgr-card" aria-labelledby="perf-props">
        <div className="mgr-card__head">
          <h2 className="mgr-h2" id="perf-props">Property comparison</h2>
          <span className="mgr-muted">Money is the last 12 months. Click a column to rank by it.</span>
        </div>
        <div className="mgr-table-wrap">
          <table className="mgr-table">
            <thead>
              <tr>
                <SortTh sorter={props} k="name">Property</SortTh>
                <SortTh sorter={props} k="occupancy" num>Occupancy</SortTh>
                <SortTh sorter={props} k="rentRoll" num>Rent roll</SortTh>
                <SortTh sorter={props} k="collected" num>Collected</SortTh>
                <SortTh sorter={props} k="expenses" num>Expenses</SortTh>
                <SortTh sorter={props} k="noi" num>NOI</SortTh>
                <SortTh sorter={props} k="outstanding" num>Owed now</SortTh>
                <SortTh sorter={props} k="maintenance" num>Open requests</SortTh>
                <SortTh sorter={props} k="expiring" num>Ending ≤90d</SortTh>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <button type="button" className="mgr-btn mgr-btn--link" onClick={() => go({ name: "property", id: r.id })}>
                      {r.name}
                    </button>
                  </th>
                  <td className="mgr-num">
                    {pct(r.occupancy)}
                    <div className="mgr-muted">
                      {r.occupied} of {r.units} units
                    </div>
                    <div className="mgr-occupancy mgr-occupancy--inline" aria-hidden="true">
                      <span style={{ width: pct(r.occupancy) }} />
                    </div>
                  </td>
                  <td className="mgr-num">
                    {money(r.rentRoll, false)}
                    <div className="mgr-muted">{money(r.avgRent, false)} avg</div>
                  </td>
                  <td className="mgr-num">
                    {money(r.collected12m, false)}
                    <div className={r.collectionRate < 0.9 ? "mgr-owes" : "mgr-muted"}>{pct(r.collectionRate)} of billed</div>
                  </td>
                  <td className="mgr-num">{money(r.expenses12m, false)}</td>
                  <td className={`mgr-num${r.noi12m < 0 ? " mgr-owes" : ""}`}>
                    <strong>{money(r.noi12m, false)}</strong>
                    <div className="mgr-muted">{money(r.units ? r.noi12m / r.units : 0, false)} / unit</div>
                  </td>
                  <td className={`mgr-num${r.outstanding > 0 ? " mgr-owes" : ""}`}>{money(r.outstanding, false)}</td>
                  <td className="mgr-num">{r.openMaintenance}</td>
                  <td className="mgr-num">{r.expiring90}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mgr-card" aria-labelledby="perf-maint">
        <h2 className="mgr-h2" id="perf-maint">Maintenance</h2>
        <dl className="mgr-stats mgr-stats--wide">
          <div>
            <dt>New</dt>
            <dd>{data.maintenance.submitted}</dd>
          </div>
          <div>
            <dt>In progress</dt>
            <dd>{data.maintenance.inProgress}</dd>
          </div>
          <div>
            <dt>Resolved (12 months)</dt>
            <dd>{data.maintenance.resolved12m}</dd>
          </div>
          <div>
            <dt>Average time to resolve</dt>
            <dd>{data.maintenance.avgResolutionDays === null ? "—" : `${data.maintenance.avgResolutionDays.toFixed(1)} days`}</dd>
          </div>
          <div>
            <dt>Oldest open request</dt>
            <dd className={data.maintenance.oldestOpenDays !== null && data.maintenance.oldestOpenDays > 7 ? "mgr-owes" : undefined}>
              {data.maintenance.oldestOpenDays === null ? "—" : `${data.maintenance.oldestOpenDays} days old`}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}

/** Plain-language observations, worked out from the same numbers on the screen. */
function performanceInsights(a: import("./finance-api").Analytics): Array<{ tone: "warn" | "good" | "note"; text: string }> {
  const out: Array<{ tone: "warn" | "good" | "note"; text: string }> = [];
  const k = a.kpis;
  const t = a.trend;
  if (t.length >= 4) {
    const recent = t.slice(-3, -1); // the last two full months
    const earlier = t.slice(0, -3);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const r1 = avg(recent.map((m) => m.collectionRate));
    const r0 = avg(earlier.filter((m) => m.billed > 0).map((m) => m.collectionRate));
    if (r0 > 0 && r1 < r0 - 0.05) out.push({ tone: "warn", text: `Collection rate slipped to ${pct(r1)} over the last two full months, from ${pct(r0)} before.` });
    else if (r0 > 0 && r1 >= r0) out.push({ tone: "good", text: `Collection rate is holding at ${pct(r1)} over the last two full months.` });
  }
  const worst = [...a.properties].filter((p) => p.units > 0).sort((x, y) => x.occupancy - y.occupancy)[0];
  if (worst && worst.occupancy < 0.9) {
    const vacant = worst.units - worst.occupied;
    out.push({ tone: "warn", text: `${worst.name} is ${pct(worst.occupancy)} occupied: ${vacant} vacant unit${vacant === 1 ? "" : "s"}, about ${money(vacant * (worst.avgRent || k.avgRent), false)} a month in rent not coming in.` });
  }
  const best = [...a.properties].sort((x, y) => (y.units ? y.noi12m / y.units : 0) - (x.units ? x.noi12m / x.units : 0))[0];
  if (best && a.properties.length > 1) out.push({ tone: "good", text: `${best.name} earns the most per unit: ${money(best.units ? best.noi12m / best.units : 0, false)} NOI per unit over 12 months.` });
  if (k.outstanding > 0) out.push({ tone: k.delinquencyRate > 0.1 ? "warn" : "note", text: `${money(k.outstanding, false)} is owed across the portfolio, ${pct(k.delinquencyRate)} of a month's rent roll. Collections on the Finance screen lists who and how late.` });
  if (k.expiring90 > 0) out.push({ tone: "note", text: `${k.expiring90} lease${k.expiring90 === 1 ? " ends" : "s end"} in the next 90 days. Sending renewal notices early avoids an empty month.` });
  if (a.maintenance.oldestOpenDays !== null && a.maintenance.oldestOpenDays > 7) out.push({ tone: "warn", text: `The oldest open maintenance request is ${a.maintenance.oldestOpenDays} days old.` });
  return out;
}

/* ------------------------------------------------------------------ *
 * Lease renewals: leases ending soon
 * ------------------------------------------------------------------ */

const WINDOWS = [30, 60, 90, 180];

export function RenewalsPage({ days }: { days: number }) {
  const { go, open, can } = useManager();
  const leases = useLoad(() => financeApi.expiring(days), [days]);
  const stats = useLoad(() => financeApi.analytics());
  const sorter = useSort("renewals", leases.data ?? [], {
    unit: (r) => r.unitLabel,
    ends: (r) => r.daysLeft,
    rent: (r) => r.monthlyRent,
    balance: (r) => r.balance,
    notice: (r) => r.lastNotice?.sentAt ?? null,
  }, { key: "ends", dir: "asc" });
  const k = stats.data?.kpis;
  const rows = leases.data ?? [];
  const urgency = (d: number) => (d <= 30 ? "late" : d <= 60 ? "partial" : "current");
  const notNotified = rows.filter((r) => !r.lastNotice).length;

  return (
    <>
      <PageHeader title="Lease renewals" subtitle="Leases ending soon, and whether the residents have heard from you about renewing." />
      {k && (
        <div className="mgr-kpis">
          <Kpi label="Total units" value={String(k.units)} onClick={() => go({ name: "rent-roll" })} />
          <Kpi label="Rented" value={String(k.occupied)} note={`${pct(k.occupancy)} occupancy`} tone="good" />
          <Kpi label="Expiring soon" value={String(k.expiring90)} note="Ending in the next 90 days" tone={k.expiring90 > 0 ? "warn" : undefined} />
          <Kpi label="Vacant" value={String(k.vacant)} note="Ready to lease" onClick={() => go({ name: "rent-roll", filter: "vacant" })} />
        </div>
      )}
      <div className="mgr-toolbar">
        <div className="mgr-tabs" role="tablist" aria-label="Ending within">
          {WINDOWS.map((w) => (
            <button key={w} type="button" role="tab" aria-selected={days === w} className={`mgr-tab${days === w ? " mgr-tab--active" : ""}`} onClick={() => go({ name: "renewals", days: w })}>
              Next {w} days
            </button>
          ))}
        </div>
        {leases.data && notNotified > 0 && (
          <span className="mgr-alert mgr-alert--inline">
            {notNotified} lease{notNotified === 1 ? "" : "s"} without a renewal notice yet
          </span>
        )}
      </div>
      {!leases.data ? (
        <Loading error={leases.error} />
      ) : (
        <section className="mgr-card">
          {rows.length > 0 && (
            <ol className="mgr-timeline" aria-label="When leases end">
              {[
                ["0–30 days", rows.filter((r) => r.daysLeft <= 30).length, "late"],
                ["31–60 days", rows.filter((r) => r.daysLeft > 30 && r.daysLeft <= 60).length, "partial"],
                ["61–90 days", rows.filter((r) => r.daysLeft > 60 && r.daysLeft <= 90).length, "current"],
                ...(days > 90 ? [["91+ days", rows.filter((r) => r.daysLeft > 90).length, "vacant"] as const] : []),
              ].map(([label, n, tone]) => (
                <li key={label} className={`mgr-timeline__step mgr-timeline__step--${tone}`}>
                  <strong>{n}</strong>
                  <span>{label}</span>
                </li>
              ))}
            </ol>
          )}
          {rows.length === 0 ? (
            <Empty>No leases end in the next {days} days.</Empty>
          ) : (
            <div className="mgr-table-wrap">
              <table className="mgr-table">
                <thead>
                  <tr>
                    <SortTh sorter={sorter} k="unit">Unit</SortTh>
                    <th scope="col">Residents</th>
                    <SortTh sorter={sorter} k="ends">Lease ends</SortTh>
                    <SortTh sorter={sorter} k="rent" num>Rent</SortTh>
                    <SortTh sorter={sorter} k="balance" num>Balance</SortTh>
                    <SortTh sorter={sorter} k="notice">Renewal notice</SortTh>
                    <th scope="col"><span className="mgr-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorter.rows.map((r) => (
                    <tr key={r.leaseId}>
                      <th scope="row">
                        {r.unitLabel}
                        <div className="mgr-muted">{r.propertyName}</div>
                      </th>
                      <td>
                        <Contact tenants={r.tenants} />
                      </td>
                      <td>
                        {isoDate(r.endDate)}
                        <div>
                          <span className={`mgr-pill mgr-pill--${urgency(r.daysLeft)}`}>{r.daysLeft === 0 ? "Ends today" : `${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"} left`}</span>
                        </div>
                      </td>
                      <td className="mgr-num">{money(r.monthlyRent)}</td>
                      <td className={`mgr-num${r.balance > 0 ? " mgr-owes" : ""}`}>{money(r.balance)}</td>
                      <td>
                        {r.lastNotice ? (
                          <>
                            <span className="mgr-pill mgr-pill--paid">Sent</span> {timeAgo(r.lastNotice.sentAt)}
                            <div className="mgr-muted">
                              to {r.lastNotice.recipients} resident{r.lastNotice.recipients === 1 ? "" : "s"}
                            </div>
                          </>
                        ) : (
                          <span className="mgr-pill mgr-pill--late">Not sent</span>
                        )}
                      </td>
                      <td className="mgr-row-actions mgr-row-actions--stack">
                        {can("messages:manage") && (
                          <button type="button" className={`mgr-btn ${r.lastNotice ? "mgr-btn--secondary" : "mgr-btn--primary"} mgr-btn--small`} onClick={() => open({ kind: "renewal", leaseId: r.leaseId, label: r.unitLabel, residents: r.tenants.map((t) => t.name) })}>
                            {r.lastNotice ? "Send again" : "Send renewal notice"}
                          </button>
                        )}
                        {can("users:provision") && (
                          <button type="button" className="mgr-btn mgr-btn--ghost mgr-btn--small" onClick={() => go({ name: "lease", id: r.leaseId })}>
                            Extend or end lease
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mgr-table-foot">A renewal notice is sent as a message to every resident on the lease; they see it in their portal Messages. To renew, open the lease and change its end date.</p>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Dialogs: + Add expense, Send renewal notice
 * ------------------------------------------------------------------ */

type DialogProps<K extends Dialog["kind"]> = Extract<Dialog, { kind: K }> & { onClose: () => void };

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="mgr-alert mgr-alert--error" role="alert">
      {error}
    </p>
  ) : null;
}

export function ExpenseDialog({ propertyId, onClose }: DialogProps<"expense">) {
  const { changed } = useManager();
  const properties = useLoad(() => managerApi.properties());
  const [category, setCategory] = useState<ExpenseCategory>("repairs");
  const [amount, setAmount] = useState("");
  const [spentOn, setSpentOn] = useState(todayIso());
  const [property, setProperty] = useState(propertyId ? String(propertyId) : "");
  const [unit, setUnit] = useState("");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const units = useLoad(() => (property ? managerApi.units(Number(property)) : Promise.resolve([])), [property]);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed("Expense added. It counts in Profit & Loss now.");
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const n = Number(amount.replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new LocalError("Enter the amount as dollars, like 186.50.");
      if (spentOn > todayIso()) throw new LocalError("The date cannot be in the future.");
      await financeApi.addExpense({
        category,
        amount: Math.round(n * 100) / 100,
        spentOn,
        propertyId: property ? Number(property) : null,
        unitId: property && unit ? Number(unit) : null,
        vendor: vendor.trim() || null,
        description: description.trim() || null,
      });
    });
  }

  return (
    <Modal title="Add expense" onClose={onClose}>
      <form className="mgr-form" onSubmit={submit}>
        <div className="mgr-form__row">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {EXPENSE_CATEGORIES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input inputMode="decimal" placeholder="186.50" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Date paid">
            <input type="date" value={spentOn} max={todayIso()} onChange={(e) => setSpentOn(e.target.value)} required />
          </Field>
        </div>
        <div className="mgr-form__row">
          <Field label="Property" hint="Leave as whole portfolio for costs like software or an umbrella policy.">
            <select
              value={property}
              onChange={(e) => {
                setProperty(e.target.value);
                setUnit("");
              }}
            >
              <option value="">Whole portfolio</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Unit (optional)">
            <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!property}>
              <option value="">{property ? "The whole property" : "Pick a property first"}</option>
              {(units.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  Unit {u.unitNum}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Vendor (optional)">
          <input maxLength={120} placeholder="Mesa Plumbing" value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <input maxLength={300} placeholder="Water heater replaced" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy}>
            {busy ? "Saving…" : "Add expense"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenewalDialog({ leaseId, label, residents, onClose }: DialogProps<"renewal">) {
  const { changed } = useManager();
  const draft = useLoad(() => financeApi.renewalDraft(leaseId), [leaseId]);
  const [body, setBody] = useState<string | null>(null);
  const text = body ?? draft.data ?? "";
  const sent = useRef(0);
  const { busy, error, run } = useSubmit(() => {
    onClose();
    changed(`Renewal notice sent to ${sent.current} resident${sent.current === 1 ? "" : "s"} of ${label}.`);
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (!text.trim()) throw new LocalError("Write a message first.");
      const r = await financeApi.sendRenewal(leaseId, text.trim());
      sent.current = r.recipients;
    }, { RATE_LIMITED: "Too many notices at once. Wait a few minutes and try again." });
  }

  return (
    <Modal title={`Renewal notice · ${label}`} onClose={onClose}>
      <form className="mgr-form" onSubmit={submit}>
        <p className="mgr-muted">
          Goes to {residents.length ? residents.join(", ") : "the residents on this lease"} as a portal message. Edit it as you like before sending.
        </p>
        <Field label="Message">
          <textarea rows={8} maxLength={2000} value={text} onChange={(e) => setBody(e.target.value)} disabled={!draft.data && !draft.error} />
        </Field>
        <span className="mgr-field__hint">{text.length} / 2000</span>
        <ErrorText error={error ?? draft.error} />
        <div className="mgr-modal__actions">
          <button type="button" className="mgr-btn mgr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="mgr-btn mgr-btn--primary" disabled={busy || !text.trim()}>
            {busy ? "Sending…" : "Send notice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
