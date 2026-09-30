/**
 * Payment plans and discretionary manager actions.
 *
 * The design position this file implements: the system should make the humane
 * action the easy one. Waiving a fee, accepting a partial payment, and opening a
 * plan are first-class operations with their own buttons, each writing an
 * audited ledger row with an actor and a stated reason. In current practice
 * these accommodations happen in a spreadsheet or a text message and never reach
 * the record, which is precisely how a resident who was granted grace ends up
 * with a delinquency anyway.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { splitEvenly } from "../../../../packages/shared/src/money.ts";
import { addDays, today } from "../../../../packages/shared/src/ids.ts";
import type { PaymentPlan, PaymentPlanInstallment } from "../../../../packages/shared/src/payments.ts";
import { postEntry, reverseEntry } from "./ledger.ts";
import { conflict, unprocessable } from "../http/errors.ts";

export interface OpenPlanOptions {
  tenancyId: string;
  totalCents: number;
  installments: number;
  firstDueDate: string;
  intervalDays: number;
  reason: string;
  suspendLateFees: boolean;
  actorUserId: string;
  actorRole: string;
}

export async function openPlan(tx: Tx, options: OpenPlanOptions): Promise<PaymentPlan> {
  const active = await tx.maybeOne<{ id: string }>(
    "SELECT id FROM payment_plans WHERE tenancy_id = $1 AND status = 'active'",
    [options.tenancyId],
  );
  if (active) {
    throw conflict(
      "This account already has an active payment plan. Close or cancel it before opening another.",
    );
  }

  if (options.firstDueDate < today()) {
    throw unprocessable("The first installment cannot be due in the past.");
  }

  const plan = await tx.one<{ id: string; opened_at: string }>(
    `INSERT INTO payment_plans (
       organization_id, property_id, tenancy_id, total_cents, reason, suspends_late_fees, opened_by_user_id
     )
     SELECT t.organization_id, t.property_id, t.id, $2, $3, $4, $5
     FROM tenancies t WHERE t.id = $1
     RETURNING id, opened_at::text AS opened_at`,
    [options.tenancyId, options.totalCents, options.reason, options.suspendLateFees, options.actorUserId],
  );

  // The odd cent goes to the first installment rather than appearing as a
  // mystery cent at the end.
  const amounts = splitEvenly(options.totalCents as Cents, options.installments);
  const created: PaymentPlanInstallment[] = [];

  for (let i = 0; i < amounts.length; i += 1) {
    const dueDate = addDays(options.firstDueDate, i * options.intervalDays);
    const row = await tx.one<{ id: string }>(
      `INSERT INTO payment_plan_installments
         (payment_plan_id, tenancy_id, property_id, sequence, due_date, amount_cents)
       SELECT $1, t.id, t.property_id, $3, $4, $5 FROM tenancies t WHERE t.id = $2
       RETURNING id`,
      [plan.id, options.tenancyId, i + 1, dueDate, amounts[i]],
    );
    created.push({
      id: row.id,
      dueDate,
      amountCents: amounts[i],
      paidCents: 0 as Cents,
      status: "scheduled",
    });
  }

  // The arrangement appears in the resident's own ledger, in their own words as
  // far as the reason allows, rather than only in a manager's screen.
  const schedule = created
    .map((i) => `$${(i.amountCents / 100).toFixed(2)} on ${i.dueDate}`)
    .join("; ");

  await postEntry(tx, {
    tenancyId: options.tenancyId,
    entryType: "annotation",
    category: "payment_plan",
    amountCents: 0,
    description:
      `Payment plan opened for $${(options.totalCents / 100).toFixed(2)} in ${options.installments} installments: ${schedule}.` +
      (options.suspendLateFees ? " Late fees are paused while this plan is followed." : ""),
    effectiveDate: today(),
    paymentPlanId: plan.id,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    actorReason: options.reason,
    idempotencyKey: `plan:${plan.id}`,
  });

  const opener = await tx.maybeOne<{ display_name: string }>(
    "SELECT display_name FROM users WHERE id = $1",
    [options.actorUserId],
  );

  return {
    id: plan.id,
    tenancyId: options.tenancyId,
    totalCents: options.totalCents as Cents,
    status: "active",
    reason: options.reason,
    openedByName: opener?.display_name ?? null,
    openedAt: plan.opened_at,
    suspendsLateFees: options.suspendLateFees,
    installments: created,
  };
}

export async function getActivePlan(tx: Tx, tenancyId: string): Promise<PaymentPlan | null> {
  const plan = await tx.maybeOne<{
    id: string;
    total_cents: number;
    status: PaymentPlan["status"];
    reason: string;
    suspends_late_fees: boolean;
    opened_at: string;
    opened_by_name: string | null;
  }>(
    `SELECT p.id, p.total_cents, p.status, p.reason, p.suspends_late_fees,
            p.opened_at::text AS opened_at, u.display_name AS opened_by_name
     FROM payment_plans p
     LEFT JOIN users u ON u.id = p.opened_by_user_id
     WHERE p.tenancy_id = $1 AND p.status = 'active'`,
    [tenancyId],
  );
  if (!plan) return null;

  const installments = await tx.many<{
    id: string;
    due_date: string;
    amount_cents: number;
    paid_cents: number;
    status: PaymentPlanInstallment["status"];
  }>(
    `SELECT id, due_date::text AS due_date, amount_cents, paid_cents, status
     FROM payment_plan_installments WHERE payment_plan_id = $1 ORDER BY sequence`,
    [plan.id],
  );

  return {
    id: plan.id,
    tenancyId,
    totalCents: plan.total_cents as Cents,
    status: plan.status,
    reason: plan.reason,
    openedByName: plan.opened_by_name,
    openedAt: plan.opened_at,
    suspendsLateFees: plan.suspends_late_fees,
    installments: installments.map((i) => ({
      id: i.id,
      dueDate: i.due_date,
      amountCents: i.amount_cents as Cents,
      paidCents: i.paid_cents as Cents,
      status: i.status,
    })),
  };
}

export async function cancelPlan(
  tx: Tx,
  planId: string,
  reason: string,
  actor: { userId: string; role: string },
): Promise<void> {
  const plan = await tx.maybeOne<{ tenancy_id: string }>(
    "SELECT tenancy_id FROM payment_plans WHERE id = $1 AND status = 'active'",
    [planId],
  );
  if (!plan) throw unprocessable("No active plan with that identifier.");

  await tx.query(
    "UPDATE payment_plans SET status = 'cancelled', closed_at = now() WHERE id = $1",
    [planId],
  );

  await postEntry(tx, {
    tenancyId: plan.tenancy_id,
    entryType: "annotation",
    category: "payment_plan",
    amountCents: 0,
    description: `Payment plan cancelled. ${reason}`,
    effectiveDate: today(),
    paymentPlanId: planId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    actorReason: reason,
    idempotencyKey: `plan:cancel:${planId}`,
  });
}

/**
 * Waive a fee, wholly or in part.
 *
 * Implemented as a reversal rather than as a deletion, so the resident's history
 * shows that a fee was charged and then waived, by whom, and why. That trail is
 * what makes the accommodation durable: a manager who leaves, or a dispute six
 * months later, does not erase the fact that grace was granted.
 */
export async function waiveFee(
  tx: Tx,
  options: {
    ledgerEntryId: string;
    amountCents?: number;
    reason: string;
    actorUserId: string;
    actorRole: string;
  },
) {
  const entry = await tx.maybeOne<{ category: string; entry_type: string; amount_cents: number }>(
    "SELECT category, entry_type, amount_cents FROM ledger_entries WHERE id = $1",
    [options.ledgerEntryId],
  );
  if (!entry) throw unprocessable("That ledger entry does not exist or is not visible to you.");
  if (entry.amount_cents <= 0) {
    throw unprocessable("Only a charge can be waived. This entry is not a charge.");
  }

  return reverseEntry(tx, {
    entryId: options.ledgerEntryId,
    amountCents: options.amountCents,
    reason: options.reason,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    category: "waiver",
    description: `Waived — ${options.reason}`,
  });
}

/** A manual adjustment: a concession, a correction, a one-off charge. */
export async function postAdjustment(
  tx: Tx,
  options: {
    tenancyId: string;
    category: string;
    amountCents: number;
    description: string;
    effectiveDate?: string;
    reason: string;
    actorUserId: string;
    actorRole: string;
  },
) {
  return postEntry(tx, {
    tenancyId: options.tenancyId,
    // A negative adjustment is a credit to the resident; a positive one is a
    // charge. Naming it correctly matters because the resident reads this word.
    entryType: options.amountCents < 0 ? "credit" : "adjustment",
    category: options.category as never,
    amountCents: options.amountCents,
    description: options.description,
    effectiveDate: options.effectiveDate,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    actorReason: options.reason,
    idempotencyKey: `adjustment:${options.tenancyId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
  });
}
