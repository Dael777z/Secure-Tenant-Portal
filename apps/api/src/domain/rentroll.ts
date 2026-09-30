/**
 * The rent roll and the exception queue.
 *
 * This component inverts the usual dashboard. A manager's month-end problem is
 * not viewing two hundred rows; it is finding the four that need a person. So
 * the exception queue is the front door and the full roll sits behind it.
 *
 * Both are computed live from the ledger rather than from a cached summary. A
 * rent roll that is thirty seconds stale shows a payment as missing after it
 * landed, and that disagreement between what the manager sees and what the
 * resident sees is the exact failure this project exists to remove. The indexes
 * in migration 003 are what make meaning that affordable.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type { PeriodKey } from "../../../../packages/shared/src/ids.ts";
import { dueDateFor, periodOf, today } from "../../../../packages/shared/src/ids.ts";
import type {
  ExceptionKind,
  ExceptionRow,
  RentRollResponse,
  RentRollRow,
  RentRollStatus,
} from "../../../../packages/shared/src/api.ts";
import { EXCEPTION_LABELS, EXCEPTION_SEVERITY } from "../../../../packages/shared/src/api.ts";
import type { PaymentStatus } from "../../../../packages/shared/src/payments.ts";
import { FAILURE_CODES } from "../../../../packages/shared/src/payments.ts";

/**
 * Money inside SQL-built detail strings. Literal separators rather than the
 * locale-dependent G/D patterns, so the text matches formatMoney() in the client
 * whatever lc_numeric the server happens to run with.
 */
const MONEY_FORMAT = "FM999,999,990.00";

/**
 * The oldest charge that is still unpaid, per tenancy — first-in, first-out,
 * matching ageBalance() in the shared package.
 *
 * Credits are applied to charges oldest first; the oldest unpaid charge is the
 * first one whose running total exceeds everything credited. Taking the oldest
 * charge *ever* instead is the easy query and the wrong one: it made a resident
 * who is $40 short this month look two years delinquent, and put them at the top
 * of the queue above people who actually are.
 *
 * One pass over the ledger, both sums as window aggregates: under row-level
 * security every row read is a policy check, so a second scan is not free.
 * Materialized so the planner cannot fold it into a per-row nested loop — which
 * it did, and which quadrupled the rent roll on a 300-unit portfolio.
 */
const OLDEST_UNPAID_CTE = `oldest_unpaid AS MATERIALIZED (
       SELECT x.tenancy_id,
              min(x.effective_date) FILTER (
                WHERE x.amount_cents > 0 AND x.running_charged > COALESCE(x.credited, 0)
              ) AS oldest_unpaid
       FROM (
         SELECT e.tenancy_id, e.effective_date, e.amount_cents,
                sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0) OVER (
                  PARTITION BY e.tenancy_id ORDER BY e.effective_date, e.posted_at, e.id
                ) AS running_charged,
                -sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0) OVER (
                  PARTITION BY e.tenancy_id
                ) AS credited
         FROM ledger_entries e
         WHERE e.tenancy_id IN (SELECT id FROM scope)
       ) x
       GROUP BY x.tenancy_id
     )`;

function managerFailureText(code: string, fallback: string): string {
  return code in FAILURE_CODES ? FAILURE_CODES[code as keyof typeof FAILURE_CODES].manager : fallback;
}

export interface RentRollOptions {
  period?: PeriodKey;
  propertyId?: string;
  status?: "all" | RentRollStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

interface RollRow {
  tenancy_id: string;
  unit_label: string;
  property_name: string;
  resident_name: string;
  resident_email: string;
  monthly_rent_cents: number;
  rent_due_day: number;
  charged_cents: number;
  paid_cents: number;
  balance_cents: number;
  last_payment_date: string | null;
  last_payment_status: PaymentStatus | null;
  has_active_plan: boolean;
  late_fees_paused: boolean;
  open_disputes: number;
  oldest_unpaid: string | null;
  total_count: number;
}

export async function rentRoll(tx: Tx, options: RentRollOptions = {}): Promise<RentRollResponse> {
  const started = Date.now();
  const period = options.period ?? periodOf(today());
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;

  // One query. The temptation on a screen like this is a list query plus a
  // per-row lookup, which is how a 300-unit rent roll becomes 900 round trips
  // and a manager decides the software is slow and goes back to the spreadsheet.
  const rows = await tx.many<RollRow>(
    `WITH scope AS (
       SELECT t.id, t.property_id, t.unit_id, t.resident_user_id, t.late_fee_hold_until,
              t.monthly_rent_cents, t.rent_due_day
       FROM tenancies t
       WHERE t.status = 'active'
         AND ($1::uuid IS NULL OR t.property_id = $1::uuid)
     ),
     period_activity AS (
       SELECT e.tenancy_id,
              COALESCE(sum(e.amount_cents) FILTER (WHERE e.amount_cents > 0), 0) AS charged,
              COALESCE(-sum(e.amount_cents) FILTER (WHERE e.amount_cents < 0), 0) AS paid
       FROM ledger_entries e
       WHERE e.period = $2 AND e.tenancy_id IN (SELECT id FROM scope)
       GROUP BY e.tenancy_id
     ),
     balances AS (
       SELECT e.tenancy_id, sum(e.amount_cents) AS balance
       FROM ledger_entries e
       WHERE e.tenancy_id IN (SELECT id FROM scope)
       GROUP BY e.tenancy_id
     ),
     ${OLDEST_UNPAID_CTE},
     last_payment AS (
       SELECT DISTINCT ON (p.tenancy_id) p.tenancy_id, p.submitted_at, p.status
       FROM payments p
       WHERE p.tenancy_id IN (SELECT id FROM scope)
       ORDER BY p.tenancy_id, p.submitted_at DESC
     ),
     assembled AS (
       SELECT
         s.id AS tenancy_id,
         u.label AS unit_label,
         pr.name AS property_name,
         usr.display_name AS resident_name,
         usr.email AS resident_email,
         s.monthly_rent_cents::bigint AS monthly_rent_cents,
         s.rent_due_day::int AS rent_due_day,
         COALESCE(pa.charged, 0)::bigint AS charged_cents,
         COALESCE(pa.paid, 0)::bigint AS paid_cents,
         COALESCE(b.balance, 0)::bigint AS balance_cents,
         lp.submitted_at::text AS last_payment_date,
         lp.status AS last_payment_status,
         EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.tenancy_id = s.id AND pp.status = 'active') AS has_active_plan,
         (s.late_fee_hold_until IS NOT NULL AND s.late_fee_hold_until >= current_date) AS late_fees_paused,
         (SELECT count(*) FROM charge_disputes d WHERE d.tenancy_id = s.id
          AND d.status IN ('open','responded'))::int AS open_disputes,
         ou.oldest_unpaid::text AS oldest_unpaid
       FROM scope s
       JOIN units u ON u.id = s.unit_id
       JOIN properties pr ON pr.id = s.property_id
       JOIN users usr ON usr.id = s.resident_user_id
       LEFT JOIN period_activity pa ON pa.tenancy_id = s.id
       LEFT JOIN balances b ON b.tenancy_id = s.id
       LEFT JOIN oldest_unpaid ou ON ou.tenancy_id = s.id
       LEFT JOIN last_payment lp ON lp.tenancy_id = s.id
       WHERE ($3::text IS NULL OR usr.display_name ILIKE '%' || $3 || '%' OR u.label ILIKE '%' || $3 || '%')
     )
     SELECT *, count(*) OVER ()::int AS total_count
     FROM assembled
     ORDER BY unit_label
     LIMIT $4 OFFSET $5`,
    [options.propertyId ?? null, period, options.search ?? null, limit, offset],
  );

  const asOf = today();
  let mapped: RentRollRow[] = rows.map((row) => {
    const charged = Number(row.charged_cents);
    const paid = Number(row.paid_cents);
    const balance = Number(row.balance_cents);
    const due = Math.max(0, charged - paid);

    return {
      tenancyId: row.tenancy_id,
      unitLabel: row.unit_label,
      propertyName: row.property_name,
      residentName: row.resident_name,
      residentEmail: row.resident_email,
      monthlyRentCents: Number(row.monthly_rent_cents) as Cents,
      dueDate: dueDateFor(period, Number(row.rent_due_day)),
      chargedCents: charged as Cents,
      paidCents: paid as Cents,
      dueCents: due as Cents,
      balanceCents: balance as Cents,
      status: classify(charged, paid, balance, row.last_payment_status),
      lastPaymentDate: row.last_payment_date,
      lastPaymentStatus: row.last_payment_status,
      hasActivePlan: row.has_active_plan,
      lateFeesPaused: row.late_fees_paused,
      openDisputes: row.open_disputes,
      daysPastDue: row.oldest_unpaid && balance > 0 ? daysBetween(row.oldest_unpaid, asOf) : 0,
    };
  });

  if (options.status && options.status !== "all") {
    mapped = mapped.filter((row) => row.status === options.status);
  }

  const totals = mapped.reduce(
    (acc, row) => ({
      charged: acc.charged + row.chargedCents,
      collected: acc.collected + row.paidCents,
      outstanding: acc.outstanding + Math.max(0, row.dueCents),
    }),
    { charged: 0, collected: 0, outstanding: 0 },
  );

  return {
    period,
    rows: mapped,
    totals: {
      units: mapped.length,
      chargedCents: totals.charged as Cents,
      collectedCents: totals.collected as Cents,
      outstandingCents: totals.outstanding as Cents,
      collectionRate: totals.charged > 0 ? totals.collected / totals.charged : 1,
    },
    total: rows[0]?.total_count ?? 0,
    generatedInMs: Date.now() - started,
  };
}

function classify(
  charged: number,
  paid: number,
  balance: number,
  lastPaymentStatus: PaymentStatus | null,
): RentRollStatus {
  // A failed or returned payment outranks the arithmetic: the number may look
  // fine for a few days while the money is on its way back out.
  if (lastPaymentStatus === "failed" || lastPaymentStatus === "returned") return "failed";
  if (balance < 0) return "credit";
  if (charged === 0) return paid > 0 ? "credit" : "paid";
  if (paid >= charged) return "paid";
  if (paid > 0) return "partial";
  return "unpaid";
}

/* ------------------------------------------------------------------ *
 * The exception queue
 * ------------------------------------------------------------------ */

interface ExceptionSource {
  kind: string;
  tenancy_id: string;
  unit_label: string;
  property_name: string;
  resident_name: string;
  amount_cents: number;
  detail: string;
  occurred_at: string;
  payment_id: string | null;
  dispute_id: string | null;
  ledger_entry_id: string | null;
  failure_code: string | null;
}

/**
 * Suggested actions per exception kind. Shipping these as data rather than as UI
 * conditionals means the manager's options are reviewable in one place, and that
 * the humane option is listed first where there is one.
 */
const ACTIONS: Record<ExceptionKind, readonly string[]> = {
  payment_returned: ["contact_resident", "open_payment_plan", "waive_fee", "record_payment"],
  payment_failed: ["contact_resident", "open_payment_plan", "record_payment"],
  dispute_open: ["review_charge", "respond_to_dispute", "waive_fee"],
  autopay_blocked: ["contact_resident", "record_payment"],
  plan_missed: ["contact_resident", "revise_plan"],
  severely_past_due: ["contact_resident", "open_payment_plan", "record_payment"],
  past_due: ["contact_resident", "open_payment_plan"],
  partial_payment: ["contact_resident", "open_payment_plan"],
  unapplied_credit: ["review_ledger", "post_refund"],
};

export async function exceptions(
  tx: Tx,
  options: { period?: PeriodKey; propertyId?: string } = {},
): Promise<{
  period: PeriodKey;
  rows: ExceptionRow[];
  countsByKind: Record<string, number>;
  generatedInMs: number;
}> {
  const started = Date.now();
  const period = options.period ?? periodOf(today());

  const rows = await tx.many<ExceptionSource>(
    `WITH scope AS (
       SELECT t.id, t.property_id, t.unit_id, t.resident_user_id, t.late_fee_hold_until
       FROM tenancies t
       WHERE t.status = 'active' AND ($1::uuid IS NULL OR t.property_id = $1::uuid)
     ),
     named AS (
       SELECT s.id AS tenancy_id, u.label AS unit_label, pr.name AS property_name,
              usr.display_name AS resident_name
       FROM scope s
       JOIN units u ON u.id = s.unit_id
       JOIN properties pr ON pr.id = s.property_id
       JOIN users usr ON usr.id = s.resident_user_id
     ),
     failures AS (
       SELECT
         CASE WHEN p.status = 'returned' THEN 'payment_returned' ELSE 'payment_failed' END AS kind,
         p.tenancy_id, p.amount_cents,
         COALESCE(p.failure_message, 'This payment did not complete.') AS detail,
         p.updated_at AS occurred_at, p.id AS payment_id,
         NULL::uuid AS dispute_id, NULL::uuid AS ledger_entry_id,
         p.failure_code
       FROM payments p
       WHERE p.tenancy_id IN (SELECT id FROM scope) AND p.status IN ('failed','returned','disputed')
         AND p.updated_at > now() - interval '60 days'
     ),
     disputes AS (
       SELECT 'dispute_open' AS kind, d.tenancy_id, abs(e.amount_cents) AS amount_cents,
              'Disputed: ' || left(d.reason, 160) AS detail,
              d.opened_at AS occurred_at, NULL::uuid AS payment_id,
              d.id AS dispute_id, d.ledger_entry_id, NULL::text AS failure_code
       FROM charge_disputes d
       JOIN ledger_entries e ON e.id = d.ledger_entry_id
       WHERE d.tenancy_id IN (SELECT id FROM scope) AND d.status IN ('open','responded')
     ),
     missed_plans AS (
       SELECT 'plan_missed' AS kind, i.tenancy_id, (i.amount_cents - i.paid_cents) AS amount_cents,
              'Plan installment of $' || to_char((i.amount_cents - i.paid_cents)/100.0, '${MONEY_FORMAT}')
                || ' due ' || i.due_date::text || ' was not met.' AS detail,
              (i.due_date + 1)::timestamptz AS occurred_at, NULL::uuid AS payment_id,
              NULL::uuid AS dispute_id, NULL::uuid AS ledger_entry_id, NULL::text AS failure_code
       FROM payment_plan_installments i
       JOIN payment_plans pl ON pl.id = i.payment_plan_id
       WHERE i.tenancy_id IN (SELECT id FROM scope) AND pl.status = 'active'
         AND i.status IN ('scheduled','partial') AND i.due_date < current_date
     ),
     ${OLDEST_UNPAID_CTE},
     balances AS (
       SELECT e.tenancy_id, sum(e.amount_cents) AS balance, ou.oldest_unpaid AS oldest
       FROM ledger_entries e
       LEFT JOIN oldest_unpaid ou ON ou.tenancy_id = e.tenancy_id
       WHERE e.tenancy_id IN (SELECT id FROM scope)
       GROUP BY e.tenancy_id, ou.oldest_unpaid
       HAVING sum(e.amount_cents) <> 0
     ),
     aging AS (
       SELECT
         CASE
           WHEN b.balance < 0 THEN 'unapplied_credit'
           WHEN current_date - b.oldest > 30 THEN 'severely_past_due'
           WHEN current_date - b.oldest > 5 THEN 'past_due'
           ELSE 'partial_payment'
         END AS kind,
         b.tenancy_id, abs(b.balance) AS amount_cents,
         CASE
           WHEN b.balance < 0 THEN 'Account carries a credit of $'
             || to_char(abs(b.balance)/100.0, '${MONEY_FORMAT}') || '.'
           ELSE '$' || to_char(b.balance/100.0, '${MONEY_FORMAT}') || ' outstanding, oldest charge '
             || (current_date - b.oldest)::text || ' days old.'
         END AS detail,
         COALESCE(b.oldest, current_date)::timestamptz AS occurred_at,
         NULL::uuid AS payment_id, NULL::uuid AS dispute_id, NULL::uuid AS ledger_entry_id,
         NULL::text AS failure_code
       FROM balances b
       -- A resident whose payment is still settling is not an exception; they
       -- are a resident who paid on time and whose bank is slow.
       WHERE NOT EXISTS (
         SELECT 1 FROM payments p WHERE p.tenancy_id = b.tenancy_id AND p.status IN ('pending','processing')
       )
     ),
     unioned AS (
       SELECT * FROM failures
       UNION ALL SELECT * FROM disputes
       UNION ALL SELECT * FROM missed_plans
       UNION ALL SELECT * FROM aging
     )
     SELECT u.kind, u.tenancy_id, n.unit_label, n.property_name, n.resident_name,
            u.amount_cents::bigint, u.detail, u.occurred_at::text AS occurred_at,
            u.payment_id, u.dispute_id, u.ledger_entry_id, u.failure_code
     FROM unioned u
     JOIN named n ON n.tenancy_id = u.tenancy_id`,
    [options.propertyId ?? null],
  );

  const mapped: ExceptionRow[] = rows.map((row) => {
    const kind = row.kind as ExceptionKind;
    return {
      kind,
      severity: EXCEPTION_SEVERITY[kind] ?? 0,
      tenancyId: row.tenancy_id,
      unitLabel: row.unit_label,
      propertyName: row.property_name,
      residentName: row.resident_name,
      amountCents: Number(row.amount_cents) as Cents,
      // The stored failure message is written to the resident ("your bank",
      // "your account"). The manager reading the queue is not that person, so
      // they get the operational description of the same failure instead.
      detail: row.failure_code ? managerFailureText(row.failure_code, row.detail) : row.detail,
      occurredAt: row.occurred_at,
      paymentId: row.payment_id,
      disputeId: row.dispute_id,
      ledgerEntryId: row.ledger_entry_id,
      suggestedActions: ACTIONS[kind] ?? [],
    };
  });

  // Severity first, then oldest — a returned payment from last week outranks one
  // from this morning, because it has been unaddressed longer.
  mapped.sort((a, b) => b.severity - a.severity || a.occurredAt.localeCompare(b.occurredAt));

  const countsByKind: Record<string, number> = {};
  for (const row of mapped) countsByKind[row.kind] = (countsByKind[row.kind] ?? 0) + 1;

  return { period, rows: mapped, countsByKind, generatedInMs: Date.now() - started };
}

export function exceptionLabel(kind: ExceptionKind): string {
  return EXCEPTION_LABELS[kind] ?? kind;
}

function daysBetween(from: string, to: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
        86_400_000,
    ),
  );
}
