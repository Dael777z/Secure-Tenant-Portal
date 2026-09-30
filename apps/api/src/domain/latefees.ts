/**
 * Late fees.
 *
 * The design position, stated once here because it shapes every branch below:
 * automated escalation is a policy a manager configures, not a behaviour the
 * software brings with it. The default is disabled. When it is enabled, a fee
 * posts only when the resident actually owes money past a grace period that the
 * manager chose, and never while the system itself is the reason the money has
 * not arrived.
 *
 * Four conditions suppress a fee that would otherwise post. Each exists because
 * the alternative penalizes someone for something they did not do:
 *
 *   A payment is in flight. ACH takes days. Charging a fee on the third day of a
 *   four-day settlement charges someone for their bank's clock.
 *
 *   A payment failed on the bank's or the processor's side. The hold is set by
 *   the payment pipeline and both parties are told. A returned debit is a
 *   problem to solve, not automatically a penalty to collect.
 *
 *   An active payment plan covers the balance. The entire point of granting a
 *   plan is that following it does not accrue fees; a plan that accrues them
 *   anyway is a spreadsheet edit wearing a system's clothes.
 *
 *   An open dispute on the underlying charge. Fees do not compound on top of an
 *   amount that is itself under review.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { percentOf } from "../../../../packages/shared/src/money.ts";
import { addDays, periodOf, today } from "../../../../packages/shared/src/ids.ts";
import { postEntry } from "./ledger.ts";

export interface LateFeePolicyRow {
  property_id: string;
  /** Where these terms come from: the lease's own (015) or its property's (006). */
  source?: "lease" | "property";
  note?: string | null;
  enabled: boolean;
  grace_days: number;
  fee_type: "flat" | "percent";
  flat_cents: number;
  percent: number;
  daily_cents: number;
  max_cents: number;
  min_balance_cents: number;
}

export type SuppressionReason =
  | "policy_disabled"
  | "within_grace"
  | "below_minimum"
  | "no_balance"
  | "payment_in_flight"
  | "failure_hold"
  | "active_plan"
  | "open_dispute"
  | "cap_reached"
  | "already_assessed";

export interface Assessment {
  tenancyId: string;
  shouldPost: boolean;
  amountCents: Cents;
  reason: SuppressionReason | "assessed";
  detail: string;
  idempotencyKey: string;
  daysPastDue: number;
}

interface Candidate {
  tenancy_id: string;
  property_id: string;
  balance_cents: number;
  oldest_unpaid_date: string | null;
  late_fee_hold_until: string | null;
  late_fee_hold_reason: string | null;
  in_flight_cents: number;
  active_plan: boolean;
  open_disputes: number;
  fees_this_period: number;
}

export function humanPolicy(policy: LateFeePolicyRow | null): string {
  const subject = policy?.source === "lease" ? "This lease" : "This property";
  if (!policy || !policy.enabled) {
    return `${subject} does not charge automatic late fees.`;
  }
  const base =
    policy.fee_type === "flat"
      ? `$${(policy.flat_cents / 100).toFixed(2)}`
      : `${policy.percent}% of the unpaid balance`;
  const when =
    policy.grace_days === 0
      ? "as soon as rent is past due"
      : `once rent is ${policy.grace_days} day${policy.grace_days === 1 ? "" : "s"} past due`;
  const clauses = [`A late fee of ${base} applies ${when}`];
  if (policy.daily_cents > 0) clauses.push(`plus $${(policy.daily_cents / 100).toFixed(2)} for each additional day`);
  if (policy.max_cents > 0) clauses.push(`up to a maximum of $${(policy.max_cents / 100).toFixed(2)} per month`);

  const sentences = [`${clauses.join(", ")}.`];
  if (policy.min_balance_cents > 0) {
    sentences.push(`Balances under $${(policy.min_balance_cents / 100).toFixed(2)} are not charged a fee.`);
  }
  sentences.push(
    "Fees are paused while a payment is processing, while a payment plan is being followed, and while a charge is under dispute.",
  );
  if (policy.source === "lease") sentences.unshift("These are the terms of this lease.");
  return sentences.join(" ");
}

export async function getPolicy(tx: Tx, propertyId: string): Promise<LateFeePolicyRow | null> {
  const row = await tx.maybeOne<LateFeePolicyRow>(
    `SELECT property_id, enabled, grace_days, fee_type, flat_cents, percent::float8 AS percent,
            daily_cents, max_cents, min_balance_cents
     FROM late_fee_policies WHERE property_id = $1`,
    [propertyId],
  );
  return row ? { ...row, source: "property" } : null;
}

const LEASE_POLICY_SELECT = `SELECT tenancy_id, property_id, enabled, grace_days, fee_type, flat_cents,
            percent::float8 AS percent, daily_cents, max_cents, min_balance_cents, note,
            updated_at::text AS updated_at
     FROM lease_late_fee_policies`;

export interface LeasePolicyRow extends LateFeePolicyRow {
  tenancy_id: string;
  updated_at: string;
}

/** The lease's own late-fee terms (015), or null when it follows its property. */
export async function getLeasePolicy(tx: Tx, tenancyId: string): Promise<LeasePolicyRow | null> {
  const row = await tx.maybeOne<LeasePolicyRow>(`${LEASE_POLICY_SELECT} WHERE tenancy_id = $1`, [tenancyId]);
  return row ? { ...row, source: "lease" } : null;
}

/** The terms a lease is actually held to: its own if it has them, else its property's. */
export async function effectivePolicy(tx: Tx, tenancyId: string, propertyId: string): Promise<LateFeePolicyRow | null> {
  return (await getLeasePolicy(tx, tenancyId)) ?? (await getPolicy(tx, propertyId));
}

/**
 * Decide, for every tenancy on a property, whether a fee is owed today.
 *
 * Returns a decision for each — including the suppressed ones and why they were
 * suppressed — because a manager asking "why did nobody get a late fee this
 * month" deserves an answer, and because these decisions are what the tests
 * assert against.
 */
export async function assessProperty(
  tx: Tx,
  propertyId: string,
  asOf: string = today(),
): Promise<Assessment[]> {
  const policy = await getPolicy(tx, propertyId);
  const period = periodOf(asOf);
  const leaseTerms = new Map(
    (await tx.many<LeasePolicyRow>(`${LEASE_POLICY_SELECT} WHERE property_id = $1`, [propertyId])).map((row) => [
      row.tenancy_id,
      { ...row, source: "lease" as const },
    ]),
  );

  const candidates = await tx.many<Candidate>(
    `SELECT
       t.id AS tenancy_id,
       t.property_id,
       COALESCE(bal.balance, 0)::bigint AS balance_cents,
       oldest.effective_date::text AS oldest_unpaid_date,
       t.late_fee_hold_until::text AS late_fee_hold_until,
       t.late_fee_hold_reason,
       COALESCE(flight.total, 0)::bigint AS in_flight_cents,
       EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.tenancy_id = t.id AND pp.status = 'active'
               AND pp.suspends_late_fees) AS active_plan,
       (SELECT count(*) FROM charge_disputes d WHERE d.tenancy_id = t.id
        AND d.status IN ('open','responded'))::int AS open_disputes,
       (SELECT count(*) FROM ledger_entries fe WHERE fe.tenancy_id = t.id
        AND fe.category = 'late_fee' AND fe.period = $2 AND fe.entry_type = 'charge')::int AS fees_this_period
     FROM tenancies t
     LEFT JOIN LATERAL (
       SELECT sum(e.amount_cents) AS balance FROM ledger_entries e WHERE e.tenancy_id = t.id
     ) bal ON true
     LEFT JOIN LATERAL (
       SELECT min(e.effective_date) AS effective_date FROM ledger_entries e
       WHERE e.tenancy_id = t.id AND e.amount_cents > 0
     ) oldest ON true
     LEFT JOIN LATERAL (
       SELECT sum(p.amount_cents) AS total FROM payments p
       WHERE p.tenancy_id = t.id AND p.status IN ('pending','processing')
     ) flight ON true
     WHERE t.property_id = $1 AND t.status = 'active'`,
    [propertyId, period],
  );

  return candidates.map((candidate) =>
    assessOne(candidate, leaseTerms.get(candidate.tenancy_id) ?? policy, asOf, period),
  );
}

function assessOne(
  candidate: Candidate,
  policy: LateFeePolicyRow | null,
  asOf: string,
  period: string,
): Assessment {
  const base = {
    tenancyId: candidate.tenancy_id,
    amountCents: 0 as Cents,
    idempotencyKey: `late_fee:${candidate.tenancy_id}:${asOf}`,
    daysPastDue: 0,
  };

  if (!policy || !policy.enabled) {
    return {
      ...base,
      shouldPost: false,
      reason: "policy_disabled",
      detail: policy?.source === "lease" ? "This lease does not charge late fees." : "This property has no late-fee policy enabled.",
    };
  }

  const balance = Number(candidate.balance_cents);
  if (balance <= 0) {
    return { ...base, shouldPost: false, reason: "no_balance", detail: "Nothing is owed." };
  }

  // Money already on its way. Charging here would charge someone for the time
  // their bank takes, which is the single most common unfair fee in this domain.
  const inFlight = Number(candidate.in_flight_cents);
  if (inFlight >= balance) {
    return {
      ...base,
      shouldPost: false,
      reason: "payment_in_flight",
      detail: `A payment covering this balance is still processing.`,
    };
  }

  if (candidate.late_fee_hold_until && candidate.late_fee_hold_until >= asOf) {
    return {
      ...base,
      shouldPost: false,
      reason: "failure_hold",
      detail:
        candidate.late_fee_hold_reason ??
        "Fee accrual is paused while a failed payment is resolved.",
    };
  }

  if (candidate.active_plan) {
    return { ...base, shouldPost: false, reason: "active_plan", detail: "A payment plan is being followed." };
  }

  if (candidate.open_disputes > 0) {
    return { ...base, shouldPost: false, reason: "open_dispute", detail: "A charge on this account is under dispute." };
  }

  const oldest = candidate.oldest_unpaid_date;
  if (!oldest) {
    return { ...base, shouldPost: false, reason: "no_balance", detail: "No dated charge to age against." };
  }

  const dueDate = oldest;
  const graceEnds = addDays(dueDate, policy.grace_days);
  if (asOf <= graceEnds) {
    return {
      ...base,
      shouldPost: false,
      reason: "within_grace",
      detail: `Still within the ${policy.grace_days}-day grace period, which ends ${graceEnds}.`,
    };
  }

  const unpaid = balance - inFlight;
  if (unpaid < policy.min_balance_cents) {
    return {
      ...base,
      shouldPost: false,
      reason: "below_minimum",
      detail: `The unpaid balance is below the $${(policy.min_balance_cents / 100).toFixed(2)} threshold.`,
    };
  }

  const daysPastDue = Math.max(0, daysBetweenDates(graceEnds, asOf));

  let amount =
    policy.fee_type === "flat"
      ? policy.flat_cents
      : (percentOf(unpaid as Cents, policy.percent) as number);

  // The one-time fee posts on the first day past grace; per-day accrual, if the
  // manager configured any, posts on each day after that.
  if (candidate.fees_this_period > 0) {
    if (policy.daily_cents <= 0) {
      return {
        ...base,
        shouldPost: false,
        reason: "already_assessed",
        detail: "A late fee has already been assessed for this period.",
      };
    }
    amount = policy.daily_cents;
  }

  if (policy.max_cents > 0) {
    // The cap is per period and counts what has already posted, so a daily
    // accrual cannot walk past the ceiling one day at a time.
    const remaining = policy.max_cents - candidate.fees_this_period * policy.daily_cents;
    if (remaining <= 0) {
      return { ...base, shouldPost: false, reason: "cap_reached", detail: "The monthly fee cap has been reached." };
    }
    amount = Math.min(amount, remaining);
  }

  if (amount <= 0) {
    return { ...base, shouldPost: false, reason: "cap_reached", detail: "The computed fee was zero." };
  }

  return {
    tenancyId: candidate.tenancy_id,
    shouldPost: true,
    amountCents: amount as Cents,
    reason: "assessed",
    detail: `${daysPastDue} day${daysPastDue === 1 ? "" : "s"} past the grace period on $${(unpaid / 100).toFixed(2)}.`,
    idempotencyKey: `late_fee:${candidate.tenancy_id}:${asOf}`,
    daysPastDue,
  };
}

export async function postAssessments(
  tx: Tx,
  assessments: Assessment[],
  asOf: string = today(),
): Promise<number> {
  let posted = 0;
  for (const assessment of assessments) {
    if (!assessment.shouldPost) continue;
    await postEntry(tx, {
      tenancyId: assessment.tenancyId,
      entryType: "charge",
      category: "late_fee",
      amountCents: assessment.amountCents,
      description: `Late fee — ${assessment.detail}`,
      effectiveDate: asOf,
      actorUserId: null,
      actorRole: "system_job",
      idempotencyKey: assessment.idempotencyKey,
    });
    posted += 1;
  }
  return posted;
}

/**
 * Suspend fee accrual for a tenancy and record why on the ledger.
 *
 * Called by the payment pipeline when a debit fails for a reason that is not
 * the resident's doing. The annotation is the point: a pause nobody can see is
 * indistinguishable from a pause that never happened, and the resident is the
 * person who most needs to know that the clock has stopped.
 */
export async function holdFees(
  tx: Tx,
  tenancyId: string,
  untilDate: string,
  reason: string,
  options: { actorUserId?: string | null; actorRole?: string; idempotencyKey: string } = {
    idempotencyKey: `hold:${tenancyId}:${untilDate}`,
  },
): Promise<void> {
  await tx.query(
    `UPDATE tenancies
     SET late_fee_hold_until = GREATEST(COALESCE(late_fee_hold_until, $2::date), $2::date),
         late_fee_hold_reason = $3
     WHERE id = $1`,
    [tenancyId, untilDate, reason],
  );

  await postEntry(tx, {
    tenancyId,
    entryType: "annotation",
    category: "other",
    amountCents: 0,
    description: `Late fees paused until ${untilDate}. ${reason}`,
    effectiveDate: today(),
    actorUserId: options.actorUserId ?? null,
    actorRole: options.actorRole ?? "system_job",
    actorReason: reason,
    idempotencyKey: options.idempotencyKey,
  });
}

export async function releaseHold(tx: Tx, tenancyId: string): Promise<void> {
  await tx.query(
    "UPDATE tenancies SET late_fee_hold_until = NULL, late_fee_hold_reason = NULL WHERE id = $1",
    [tenancyId],
  );
}

function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
