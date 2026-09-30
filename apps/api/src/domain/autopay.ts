/**
 * Autopay.
 *
 * The design decision that matters here is the cap. Autopay with no ceiling is a
 * standing authorization to draft whatever the ledger happens to say, which
 * means a billing error — a duplicate charge, a fee posted in error, a rent
 * increase entered with an extra digit — becomes an unexpected withdrawal from
 * the account of someone who may be running close to the line. The cap is the
 * resident's own bound on that, it is theirs to set, and when it blocks a draft
 * the resident is told what happened and that nothing was taken.
 *
 * The other decision: a draft is announced three days before it happens. An
 * autopay that surprises you is only nominally a convenience.
 *
 * Split rent (021). On a shared lease each resident can have their own autopay
 * for their share: a fixed amount each month from their own bank account. The
 * alternative is one autopay for the whole balance, from one person's account.
 * A lease has one or the other, never both, or the rent would be drafted twice.
 * Two rules keep a share draft from taking more than it should:
 *   * it never takes more than the lease still owes, and
 *   * if the person already paid something themselves since their last draft,
 *     it takes only the rest of their share.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type { AutopayEnrollment } from "../../../../packages/shared/src/payments.ts";
import { dueDateFor, periodOf, shiftPeriod, today } from "../../../../packages/shared/src/ids.ts";
import { getBalance } from "./ledger.ts";
import { conflict, unprocessable } from "../http/errors.ts";
import { PostgresError } from "../db/protocol.ts";

interface EnrollmentRow {
  id: string;
  tenancy_id: string;
  payment_method_id: string;
  day_of_month: number;
  cap_cents: number | null;
  share_cents: number | null;
  active: boolean;
  created_at: string;
  method_label: string | null;
  last_drafted_period: string | null;
  created_by_user_id: string;
  set_up_by_name: string | null;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function enroll(
  tx: Tx,
  options: {
    tenancyId: string;
    paymentMethodId: string;
    dayOfMonth: number;
    capCents: number | null;
    /** Null: the whole balance. Otherwise this person's share each month. */
    shareCents?: number | null;
    actorUserId: string;
  },
): Promise<AutopayEnrollment> {
  const method = await tx.maybeOne<{ id: string; verified: boolean; kind: string; user_id: string }>(
    "SELECT id, verified, kind, user_id FROM payment_methods WHERE id = $1 AND tenancy_id = $2 AND removed_at IS NULL",
    [options.paymentMethodId, options.tenancyId],
  );
  if (!method) throw unprocessable("That payment method is not available on this account.");
  if (!method.verified) {
    throw unprocessable("This account has not finished verification yet, so it cannot be used for autopay.");
  }
  const shareCents = options.shareCents ?? null;
  if (shareCents !== null && options.capCents !== null && options.capCents < shareCents) {
    throw unprocessable(
      `Your limit (${dollars(options.capCents)}) is below your share (${dollars(shareCents)}), so autopay would never run. Raise the limit or leave it empty.`,
    );
  }

  // Replacing your own autopay; a roommate's is left alone.
  await cancel(tx, options.tenancyId, options.actorUserId);

  try {
    await tx.query(
      `INSERT INTO autopay_enrollments
         (organization_id, property_id, tenancy_id, payment_method_id, day_of_month, cap_cents,
          share_cents, created_by_user_id)
       SELECT t.organization_id, t.property_id, t.id, $2, $3, $4, $5, $6
       FROM tenancies t WHERE t.id = $1`,
      [
        options.tenancyId, options.paymentMethodId, options.dayOfMonth, options.capCents,
        shareCents, options.actorUserId,
      ],
    );
  } catch (error) {
    // Throws rather than continuing, so the aborted transaction is rolled
    // back by the caller rather than queried again.
    if (error instanceof PostgresError && error.isUniqueViolation) {
      throw conflict("You already have autopay on this lease.");
    }
    if (error instanceof PostgresError && error.isCheckViolation && /autopay/i.test(error.message)) {
      throw conflict(explainRuleRefusal(error.message));
    }
    throw error;
  }

  return (await mine(tx, options.tenancyId, options.actorUserId))!;
}

function explainRuleRefusal(message: string): string {
  if (/whole balance would draft/.test(message)) {
    return "Someone else on your lease already has autopay for their share. Autopay for the whole balance would take the rent twice, so choose “My share” instead.";
  }
  if (/already has autopay for the whole balance/.test(message)) {
    return "Another resident already has autopay for the whole balance on this lease. They have to turn it off before anyone sets up autopay for a share.";
  }
  if (/bank account of the person/.test(message)) {
    return "Autopay for your share has to come from your own bank account.";
  }
  return "Autopay could not be set up that way on this lease.";
}

/** Stop one person's autopay on a lease. Returns whether there was one. */
export async function cancel(tx: Tx, tenancyId: string, userId: string): Promise<boolean> {
  const result = await tx.query(
    `UPDATE autopay_enrollments SET active = false, cancelled_at = now()
     WHERE tenancy_id = $1 AND created_by_user_id = $2 AND active`,
    [tenancyId, userId],
  );
  return result.rowCount > 0;
}

/** Stop every autopay on a lease (the office). */
export async function cancelAll(tx: Tx, tenancyId: string): Promise<number> {
  const result = await tx.query(
    "UPDATE autopay_enrollments SET active = false, cancelled_at = now() WHERE tenancy_id = $1 AND active",
    [tenancyId],
  );
  return result.rowCount;
}

async function rows(tx: Tx, tenancyId: string): Promise<EnrollmentRow[]> {
  return tx.many<EnrollmentRow>(
    `SELECT a.id, a.tenancy_id, a.payment_method_id, a.day_of_month, a.cap_cents, a.share_cents, a.active,
            a.created_at::text AS created_at, a.last_drafted_period,
            CASE WHEN m.id IS NULL THEN NULL
                 WHEN m.last4 IS NOT NULL
                 THEN COALESCE(m.institution, m.brand, 'Payment method') || ' ••••' || m.last4
                 ELSE COALESCE(m.institution, m.brand, 'Payment method') END AS method_label,
            a.created_by_user_id,
            (SELECT n.display_name FROM app.lease_member_names(a.tenancy_id) n
             WHERE n.user_id = a.created_by_user_id) AS set_up_by_name
     FROM autopay_enrollments a
     -- LEFT: on a shared lease, autopay may draw on a roommate's bank account,
     -- which this resident cannot see (016). They still need to know it is on.
     LEFT JOIN payment_methods m ON m.id = a.payment_method_id
     WHERE a.tenancy_id = $1 AND a.active
     ORDER BY (a.share_cents IS NULL) DESC, a.created_at`,
    [tenancyId],
  );
}

/** Every autopay on the lease: one for the whole balance, or one share per person. */
export async function listForLease(tx: Tx, tenancyId: string): Promise<AutopayEnrollment[]> {
  const found = await rows(tx, tenancyId);
  if (found.length === 0) return [];
  const balance = await getBalance(tx, tenancyId);
  const out: AutopayEnrollment[] = [];
  for (const row of found) out.push(await present(tx, row, balance));
  return out;
}

/** This person's own autopay on the lease, if they have one. */
export async function mine(tx: Tx, tenancyId: string, userId: string): Promise<AutopayEnrollment | null> {
  const row = (await rows(tx, tenancyId)).find((r) => r.created_by_user_id === userId);
  return row ? present(tx, row, await getBalance(tx, tenancyId)) : null;
}

/**
 * The autopay that covers the person looking: their own, or else a roommate's
 * autopay for the whole balance. A roommate's share does not cover them.
 * For the office, the lease's autopay (the first, when there are shares).
 */
export async function get(tx: Tx, tenancyId: string): Promise<AutopayEnrollment | null> {
  const all = await listForLease(tx, tenancyId);
  if (tx.context.role !== "tenant") return all[0] ?? null;
  return all.find((a) => a.setUpByMe) ?? all.find((a) => a.shareCents === null) ?? null;
}

async function present(tx: Tx, row: EnrollmentRow, balance: Cents): Promise<AutopayEnrollment> {
  const mineToChange = tx.context.role === "tenant" && row.created_by_user_id === tx.context.userId;
  const date = nextDraftDate(row, today());
  let amount: Cents;
  let alreadyPaid = 0;
  if (row.share_cents === null) {
    amount = Math.max(0, balance) as Cents;
  } else {
    alreadyPaid = await paidByHandSinceLastDraft(tx, row.tenancy_id, row.created_by_user_id, row.day_of_month, date);
    amount = shareDraft(row.share_cents, alreadyPaid, balance);
  }

  let blockedReason: string | null = null;
  if (amount > 0 && row.cap_cents !== null && amount > row.cap_cents) {
    blockedReason =
      row.share_cents === null
        ? `Your balance of ${dollars(amount)} is above the ${dollars(row.cap_cents)} limit you set, so autopay will not draft it. ` +
          `Nothing will be taken automatically — you can pay manually or raise the limit.`
        : `Your share of ${dollars(amount)} is above the ${dollars(row.cap_cents)} limit you set, so autopay will not draft it. ` +
          `Nothing will be taken automatically — you can pay manually or raise the limit.`;
  }

  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    paymentMethodId: row.payment_method_id,
    methodLabel: row.method_label ?? "Another resident's bank account",
    setUpByName: row.set_up_by_name ?? null,
    setUpByUserId: row.created_by_user_id,
    setUpByMe: tx.context.role !== "tenant" || mineToChange,
    dayOfMonth: row.day_of_month,
    capCents: row.cap_cents === null ? null : (row.cap_cents as Cents),
    shareCents: row.share_cents === null ? null : (row.share_cents as Cents),
    paidByHandThisCycleCents: alreadyPaid as Cents,
    active: row.active,
    nextDraftDate: date,
    nextDraftAmountCents: amount,
    nextDraftBlockedReason: blockedReason,
    createdAt: row.created_at,
  };
}

function nextDraftDate(row: { day_of_month: number; last_drafted_period: string | null }, asOf: string): string {
  const currentPeriod = periodOf(asOf);
  const thisMonth = dueDateFor(currentPeriod, row.day_of_month);
  const alreadyRan = row.last_drafted_period === currentPeriod;
  return !alreadyRan && thisMonth >= asOf ? thisMonth : dueDateFor(shiftPeriod(currentPeriod, 1), row.day_of_month);
}

/** The draft date a month before `draftDate`: the start of this share's cycle. */
function previousDraftDate(dayOfMonth: number, draftDate: string): string {
  return dueDateFor(shiftPeriod(periodOf(draftDate), -1), dayOfMonth);
}

/**
 * What a share draft takes: the share, less what the person paid by hand this
 * cycle, and never more than the lease owes.
 */
export function shareDraft(shareCents: number, paidByHand: number, leaseOwes: number): Cents {
  return Math.max(0, Math.min(shareCents - paidByHand, leaseOwes)) as Cents;
}

/**
 * Payments this person made themselves (not by autopay, not recorded by the
 * office) after their previous draft date, up to and including this one.
 * Failed and returned payments do not count.
 */
async function paidByHandSinceLastDraft(
  tx: Tx,
  tenancyId: string,
  userId: string,
  dayOfMonth: number,
  draftDate: string,
): Promise<number> {
  const row = await tx.one<{ paid: number }>(
    `SELECT COALESCE(sum(amount_cents), 0)::bigint AS paid
     FROM payments
     WHERE tenancy_id = $1 AND initiated_by_user_id = $2 AND initiated_by_role = 'tenant'
       AND status IN ('pending','processing','settled')
       AND submitted_at::date > $3::date AND submitted_at::date <= $4::date`,
    [tenancyId, userId, previousDraftDate(dayOfMonth, draftDate), draftDate],
  );
  return Number(row.paid);
}

export interface DueDraft {
  enrollmentId: string;
  tenancyId: string;
  paymentMethodId: string;
  /** Whose autopay this is; the payment is recorded as theirs. */
  userId: string;
  /** Null for the whole balance. */
  shareCents: number | null;
  amountCents: Cents;
  capCents: number | null;
  period: string;
  blocked: boolean;
  blockReason: string | null;
}

/**
 * Everything that should draft today.
 *
 * A tenancy with a payment already in flight is not drafted for that amount
 * again: someone who paid manually on the 30th must not also be drafted on the
 * 1st because the earlier payment has not settled yet. Shares on the same
 * lease are drafted in the order they were set up, and together never take
 * more than the lease owes.
 */
export async function findDue(tx: Tx, asOf: string = today()): Promise<DueDraft[]> {
  const period = periodOf(asOf);
  const day = Number(asOf.slice(8, 10));

  const found = await tx.many<{
    id: string;
    tenancy_id: string;
    payment_method_id: string;
    created_by_user_id: string;
    cap_cents: number | null;
    share_cents: number | null;
    day_of_month: number;
    balance: number;
    in_flight: number;
  }>(
    `SELECT a.id, a.tenancy_id, a.payment_method_id, a.created_by_user_id, a.cap_cents, a.share_cents,
            a.day_of_month,
            COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e WHERE e.tenancy_id = a.tenancy_id), 0)::bigint AS balance,
            COALESCE((SELECT sum(p.amount_cents) FROM payments p
                      WHERE p.tenancy_id = a.tenancy_id AND p.status IN ('pending','processing')), 0)::bigint AS in_flight
     FROM autopay_enrollments a
     JOIN payment_methods m ON m.id = a.payment_method_id
     JOIN tenancies t ON t.id = a.tenancy_id
     WHERE a.active
       AND m.removed_at IS NULL
       AND m.verified
       AND t.status = 'active'
       AND a.day_of_month = $1
       AND (a.last_drafted_period IS DISTINCT FROM $2)
     ORDER BY a.tenancy_id, (a.share_cents IS NULL) DESC, a.created_at`,
    [day, period],
  );

  const due: DueDraft[] = [];
  const remainingByLease = new Map<string, number>();

  for (const row of found) {
    if (!remainingByLease.has(row.tenancy_id)) {
      remainingByLease.set(row.tenancy_id, Number(row.balance) - Number(row.in_flight));
    }
    const remaining = remainingByLease.get(row.tenancy_id)!;

    let amount: number;
    if (row.share_cents === null) {
      amount = remaining;
    } else {
      const paid = await paidByHandSinceLastDraft(tx, row.tenancy_id, row.created_by_user_id, row.day_of_month, asOf);
      amount = shareDraft(Number(row.share_cents), paid, remaining);
    }
    if (amount <= 0) continue;

    const blocked = row.cap_cents !== null && amount > row.cap_cents;
    if (!blocked) remainingByLease.set(row.tenancy_id, remaining - amount);

    due.push({
      enrollmentId: row.id,
      tenancyId: row.tenancy_id,
      paymentMethodId: row.payment_method_id,
      userId: row.created_by_user_id,
      shareCents: row.share_cents === null ? null : Number(row.share_cents),
      amountCents: amount as Cents,
      capCents: row.cap_cents,
      period,
      blocked,
      blockReason: blocked
        ? `${row.share_cents === null ? "Balance" : "Share"} of ${dollars(amount)} exceeds the resident's autopay limit of ${dollars(row.cap_cents!)}.`
        : null,
    });
  }

  return due;
}

export async function markDrafted(tx: Tx, enrollmentId: string, period: string): Promise<void> {
  await tx.query("UPDATE autopay_enrollments SET last_drafted_period = $2 WHERE id = $1", [
    enrollmentId,
    period,
  ]);
}

export interface UpcomingDraft {
  enrollmentId: string;
  tenancyId: string;
  /** Set for a share: only that person is told. Null: everyone on the lease. */
  residentUserId: string | null;
  isShare: boolean;
  amountCents: Cents;
  draftDate: string;
  methodLabel: string;
  period: string;
}

/** Autopay drafts three days out, for the advance notice. */
export async function findUpcoming(tx: Tx, asOf: string = today()): Promise<UpcomingDraft[]> {
  const target = new Date(`${asOf}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() + 3);
  const draftDate = target.toISOString().slice(0, 10);
  const day = Number(draftDate.slice(8, 10));
  const period = periodOf(draftDate);

  const found = await tx.many<{
    id: string;
    tenancy_id: string;
    created_by_user_id: string;
    share_cents: number | null;
    day_of_month: number;
    balance: number;
    method_label: string;
  }>(
    `SELECT a.id, a.tenancy_id, a.created_by_user_id, a.share_cents, a.day_of_month,
            COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e WHERE e.tenancy_id = a.tenancy_id), 0)::bigint AS balance,
            CASE WHEN m.last4 IS NOT NULL
                 THEN COALESCE(m.institution, m.brand, 'Payment method') || ' ••••' || m.last4
                 ELSE COALESCE(m.institution, m.brand, 'Payment method') END AS method_label
     FROM autopay_enrollments a
     JOIN payment_methods m ON m.id = a.payment_method_id
     JOIN tenancies t ON t.id = a.tenancy_id
     WHERE a.active AND m.removed_at IS NULL AND t.status = 'active'
       AND a.day_of_month = $1 AND (a.last_drafted_period IS DISTINCT FROM $2)
     ORDER BY a.tenancy_id, (a.share_cents IS NULL) DESC, a.created_at`,
    [day, period],
  );

  const out: UpcomingDraft[] = [];
  for (const row of found) {
    const balance = Number(row.balance);
    let amount: number;
    if (row.share_cents === null) {
      amount = balance;
    } else {
      const paid = await paidByHandSinceLastDraft(tx, row.tenancy_id, row.created_by_user_id, row.day_of_month, draftDate);
      amount = shareDraft(Number(row.share_cents), paid, balance);
    }
    if (amount <= 0) continue;
    out.push({
      enrollmentId: row.id,
      tenancyId: row.tenancy_id,
      residentUserId: row.share_cents === null ? null : row.created_by_user_id,
      isShare: row.share_cents !== null,
      amountCents: amount as Cents,
      draftDate,
      methodLabel: row.method_label,
      period,
    });
  }
  return out;
}
