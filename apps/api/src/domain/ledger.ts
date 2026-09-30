/**
 * The ledger service: the only path through which a row reaches the ledger.
 *
 * Everything that moves money in this system — a resident's card payment, a
 * scheduled rent charge, a manager's waiver, a maintenance credit, an ACH
 * return arriving four days late — funnels through `postEntry`. There is no
 * second way in. That is what makes the invariants testable: if the balance is
 * the sum of the rows, and every row is written here, then a property that holds
 * for this function holds for the system.
 */

import { randomUUID } from "node:crypto";
import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type {
  EntryCategory,
  EntryType,
  LedgerEntry,
} from "../../../../packages/shared/src/ledger.ts";
import type { PeriodKey } from "../../../../packages/shared/src/ids.ts";
import { periodOf, today } from "../../../../packages/shared/src/ids.ts";
import { conflict, unprocessable } from "../http/errors.ts";
import { PostgresError } from "../db/protocol.ts";

export interface PostEntryInput {
  tenancyId: string;
  entryType: EntryType;
  category: EntryCategory;
  amountCents: number;
  description: string;
  period?: PeriodKey;
  effectiveDate?: string;
  reversesEntryId?: string | null;
  paymentId?: string | null;
  workOrderId?: string | null;
  paymentPlanId?: string | null;
  disputeId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  actorReason?: string | null;
  /**
   * Required. Derived from the facts of what happened — never from a timestamp
   * or a fresh uuid — so that replaying the same event is a no-op rather than a
   * second charge. `rent:<tenancy>:<period>` is the shape to aim for.
   */
  idempotencyKey: string;
}

const SELECT_ENTRY = `
  SELECT
    e.id, e.tenancy_id, e.property_id, e.entry_type, e.category, e.amount_cents,
    e.description, e.period, e.effective_date::text AS effective_date, e.posted_at::text AS posted_at,
    e.reverses_entry_id, e.payment_id, e.work_order_id, e.payment_plan_id, e.dispute_id,
    e.actor_user_id, e.actor_role, e.actor_reason, e.idempotency_key,
    actor.display_name AS actor_name,
    rev.id AS reversed_by_entry_id
  FROM ledger_entries e
  LEFT JOIN users actor ON actor.id = e.actor_user_id
  LEFT JOIN LATERAL (
    SELECT r.id FROM ledger_entries r WHERE r.reverses_entry_id = e.id ORDER BY r.posted_at LIMIT 1
  ) rev ON true
`;

type EntryRow = {
  id: string;
  tenancy_id: string;
  property_id: string;
  entry_type: EntryType;
  category: EntryCategory;
  amount_cents: number;
  description: string;
  period: string;
  effective_date: string;
  posted_at: string;
  reverses_entry_id: string | null;
  payment_id: string | null;
  work_order_id: string | null;
  payment_plan_id: string | null;
  dispute_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_reason: string | null;
  idempotency_key: string;
  actor_name: string | null;
  reversed_by_entry_id: string | null;
};

export function toLedgerEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    propertyId: row.property_id,
    entryType: row.entry_type,
    category: row.category,
    amountCents: row.amount_cents as Cents,
    description: row.description,
    period: row.period,
    effectiveDate: row.effective_date,
    postedAt: row.posted_at,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
    paymentId: row.payment_id,
    workOrderId: row.work_order_id,
    paymentPlanId: row.payment_plan_id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    actorReason: row.actor_reason,
    idempotencyKey: row.idempotency_key,
  };
}

/**
 * Append one row.
 *
 * Idempotent by construction: a second call with the same key returns the row
 * the first call wrote, rather than writing a second one or raising. That is
 * what makes it safe to retry a webhook, re-run the charge scheduler, or have a
 * resident double-tap Pay on a train.
 */
export async function postEntry(tx: Tx, input: PostEntryInput): Promise<LedgerEntry> {
  const effectiveDate = input.effectiveDate ?? today();
  const period = input.period ?? periodOf(effectiveDate);

  // The tenancy supplies organization and property, which keeps those columns
  // from ever disagreeing with the tenancy they hang from. This read is itself
  // subject to RLS: a caller who cannot see the tenancy cannot post to it.
  const tenancy = await tx.maybeOne<{ organization_id: string; property_id: string }>(
    "SELECT organization_id, property_id FROM tenancies WHERE id = $1",
    [input.tenancyId],
  );
  if (!tenancy) {
    throw unprocessable("That tenancy does not exist or is not visible to you.");
  }

  // Two properties are being bought here, and both matter.
  //
  // Insert-then-read rather than one data-modifying CTE: in PostgreSQL a CTE
  // that writes is not visible to the enclosing query's snapshot, so
  // `WITH inserted AS (INSERT ...) SELECT ... WHERE id IN (SELECT ...)`
  // silently returns nothing.
  //
  // ON CONFLICT DO NOTHING rather than catching a unique violation: in
  // PostgreSQL a failed statement aborts the whole transaction, and every call
  // here is inside one. Catching the error and then reading the existing row
  // would fail with "current transaction is aborted" — which is to say
  // idempotency would break in exactly the situation it exists for, a retried
  // payment. ON CONFLICT keeps the transaction healthy.
  const inserted = await tx.maybeOne<{ id: string }>(
    `INSERT INTO ledger_entries (
       organization_id, property_id, tenancy_id, entry_type, category, amount_cents,
       description, period, effective_date, reverses_entry_id, payment_id, work_order_id,
       payment_plan_id, dispute_id, actor_user_id, actor_role, actor_reason, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      tenancy.organization_id,
      tenancy.property_id,
      input.tenancyId,
      input.entryType,
      input.category,
      input.amountCents,
      input.description,
      period,
      effectiveDate,
      input.reversesEntryId ?? null,
      input.paymentId ?? null,
      input.workOrderId ?? null,
      input.paymentPlanId ?? null,
      input.disputeId ?? null,
      input.actorUserId ?? null,
      input.actorRole ?? null,
      input.actorReason ?? null,
      input.idempotencyKey,
    ],
  );

  // No row returned means this key was already posted. Return what is there:
  // a repeat is the ordinary case on a retry, not an error.
  const row = inserted
    ? await tx.one<EntryRow>(`${SELECT_ENTRY} WHERE e.id = $1`, [inserted.id])
    : await tx.one<EntryRow>(`${SELECT_ENTRY} WHERE e.idempotency_key = $1`, [input.idempotencyKey]);

  return toLedgerEntry(row);
}

/** Post several rows atomically. Either the whole set lands or none of it does. */
export async function postEntries(tx: Tx, inputs: PostEntryInput[]): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  for (const input of inputs) out.push(await postEntry(tx, input));
  return out;
}

/**
 * Reverse a row, wholly or partly.
 *
 * The only correction mechanism in the system. A waived fee, a mistaken charge,
 * a returned payment and a dispute resolved in the resident's favour all arrive
 * here, and all leave the original row exactly where it was.
 */
export async function reverseEntry(
  tx: Tx,
  options: {
    entryId: string;
    amountCents?: number;
    reason: string;
    actorUserId: string | null;
    actorRole: string;
    category?: EntryCategory;
    description?: string;
    disputeId?: string | null;
  },
): Promise<{ original: LedgerEntry; reversal: LedgerEntry }> {
  const original = await tx.maybeOne<EntryRow>(`${SELECT_ENTRY} WHERE e.id = $1`, [options.entryId]);
  if (!original) throw unprocessable("That ledger entry does not exist or is not visible to you.");

  if (original.entry_type === "reversal") {
    throw conflict("A reversal cannot itself be reversed. Post a fresh entry instead.");
  }
  if (original.entry_type === "annotation") {
    throw conflict("An annotation carries no amount, so there is nothing to reverse.");
  }

  const alreadyReversed = await tx.one<{ total: number }>(
    "SELECT COALESCE(sum(abs(amount_cents)), 0)::bigint AS total FROM ledger_entries WHERE reverses_entry_id = $1",
    [options.entryId],
  );

  const remaining = Math.abs(original.amount_cents) - Number(alreadyReversed.total);
  if (remaining <= 0) {
    throw conflict("That entry has already been fully reversed.");
  }

  const magnitude = options.amountCents ?? remaining;
  if (magnitude <= 0) throw unprocessable("A reversal amount must be positive.");
  if (magnitude > remaining) {
    throw unprocessable(
      `Only ${(remaining / 100).toFixed(2)} of that entry remains unreversed.`,
    );
  }

  const signed = original.amount_cents > 0 ? -magnitude : magnitude;
  const partial = magnitude < Math.abs(original.amount_cents);

  const reversal = await postEntry(tx, {
    tenancyId: original.tenancy_id,
    entryType: "reversal",
    category: options.category ?? original.category,
    amountCents: signed,
    description:
      options.description ??
      `${partial ? "Partial reversal" : "Reversal"} of ${original.description}`,
    // Accounted to the period of the row being corrected, so that a fee
    // reversed in October still shows against the September it belonged to.
    period: original.period,
    effectiveDate: today(),
    reversesEntryId: original.id,
    disputeId: options.disputeId ?? null,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    actorReason: options.reason,
    idempotencyKey: `reversal:${original.id}:${randomUUID()}`,
  });

  return { original: toLedgerEntry(original), reversal };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface LedgerQueryOptions {
  period?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function getEntries(
  tx: Tx,
  tenancyId: string,
  options: LedgerQueryOptions = {},
): Promise<LedgerEntry[]> {
  const rows = await tx.many<EntryRow>(
    `${SELECT_ENTRY}
     WHERE e.tenancy_id = $1
       AND ($2::text IS NULL OR e.period = $2::text)
       AND ($3::date IS NULL OR e.effective_date >= $3::date)
       AND ($4::date IS NULL OR e.effective_date <= $4::date)
     ORDER BY e.effective_date DESC, e.posted_at DESC
     LIMIT $5`,
    [tenancyId, options.period ?? null, options.from ?? null, options.to ?? null, options.limit ?? 200],
  );
  return rows.map(toLedgerEntry);
}

export async function getEntry(tx: Tx, entryId: string): Promise<LedgerEntry | null> {
  const row = await tx.maybeOne<EntryRow>(`${SELECT_ENTRY} WHERE e.id = $1`, [entryId]);
  return row ? toLedgerEntry(row) : null;
}

/**
 * The balance, as the sum of the rows. There is no cached total to reconcile
 * against, because a cached total is the second copy of the record that this
 * whole project exists to eliminate.
 */
export async function getBalance(tx: Tx, tenancyId: string): Promise<Cents> {
  const row = await tx.one<{ balance: number }>(
    "SELECT COALESCE(sum(amount_cents), 0)::bigint AS balance FROM ledger_entries WHERE tenancy_id = $1",
    [tenancyId],
  );
  return Number(row.balance) as Cents;
}

/** Balances for many tenancies at once, for the rent roll. */
export async function getBalances(tx: Tx, tenancyIds: string[]): Promise<Map<string, Cents>> {
  if (tenancyIds.length === 0) return new Map();
  const rows = await tx.many<{ tenancy_id: string; balance: number }>(
    `SELECT tenancy_id, COALESCE(sum(amount_cents), 0)::bigint AS balance
     FROM ledger_entries WHERE tenancy_id = ANY($1::uuid[]) GROUP BY tenancy_id`,
    [tenancyIds],
  );
  const out = new Map<string, Cents>();
  for (const id of tenancyIds) out.set(id, 0 as Cents);
  for (const row of rows) out.set(row.tenancy_id, Number(row.balance) as Cents);
  return out;
}

/**
 * Everything that produced one row, assembled for the resident's "why is this
 * here" view. This is the concrete form of the claim that a disputed charge can
 * be reconstructed months later by either party from the same source of truth.
 */
export async function traceEntry(tx: Tx, entryId: string) {
  const entry = await getEntry(tx, entryId);
  if (!entry) return null;

  const [reverses, reversedBy, siblings] = await Promise.all([
    entry.reversesEntryId ? getEntry(tx, entry.reversesEntryId) : Promise.resolve(null),
    entry.reversedByEntryId ? getEntry(tx, entry.reversedByEntryId) : Promise.resolve(null),
    // Other rows arising from the same cause: the charge a payment settled
    // against, the fee a plan suspended, the credit a work order produced.
    tx.many<EntryRow>(
      `${SELECT_ENTRY}
       WHERE e.tenancy_id = $1
         AND e.id <> $2
         AND (
           ($3::uuid IS NOT NULL AND e.payment_id = $3::uuid)
           OR ($4::uuid IS NOT NULL AND e.work_order_id = $4::uuid)
           OR ($5::uuid IS NOT NULL AND e.payment_plan_id = $5::uuid)
         )
       ORDER BY e.posted_at`,
      [entry.tenancyId, entry.id, entry.paymentId, entry.workOrderId, entry.paymentPlanId],
    ),
  ]);

  return {
    entry,
    reverses,
    reversedBy,
    relatedEntries: siblings.map(toLedgerEntry),
  };
}

/**
 * Explain an automatically-posted row in plain language.
 *
 * A resident reading "Late fee — $50.00" is owed the sentence that says which
 * rule produced it and when the manager configured that rule. "The system did it
 * automatically" is not an answer anyone can act on.
 */
export async function explainPolicy(tx: Tx, entry: LedgerEntry): Promise<string | null> {
  if (entry.category !== "late_fee" && entry.category !== "nsf_fee") return null;

  const policy = await tx.maybeOne<{
    grace_days: number;
    fee_type: string;
    flat_cents: number;
    percent: number;
    daily_cents: number;
    max_cents: number;
    updated_at: string | null;
    updated_by: string | null;
  }>(
    `SELECT p.grace_days, p.fee_type, p.flat_cents, p.percent, p.daily_cents, p.max_cents,
            p.updated_at::text AS updated_at, u.display_name AS updated_by
     FROM late_fee_policies p
     LEFT JOIN users u ON u.id = p.updated_by_user_id
     WHERE p.property_id = $1`,
    [entry.propertyId],
  );

  if (!policy) return null;

  const amount =
    policy.fee_type === "flat"
      ? `$${(policy.flat_cents / 100).toFixed(2)}`
      : `${policy.percent}% of the balance`;

  const parts = [
    `This fee was posted automatically under the property's late-fee policy:`,
    `${amount} once a balance is ${policy.grace_days} days past due`,
  ];
  if (policy.daily_cents > 0) {
    parts.push(`plus $${(policy.daily_cents / 100).toFixed(2)} per additional day`);
  }
  if (policy.max_cents > 0) {
    parts.push(`capped at $${(policy.max_cents / 100).toFixed(2)}`);
  }
  const sentence = `${parts.join(", ")}.`;

  const attribution = policy.updated_by
    ? ` The policy was last set by ${policy.updated_by}${policy.updated_at ? ` on ${policy.updated_at.slice(0, 10)}` : ""}.`
    : "";

  return sentence + attribution + " If you believe it was applied in error, you can dispute this charge.";
}
