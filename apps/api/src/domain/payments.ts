/**
 * The payment pipeline.
 *
 * Submission, reconciliation, and the failure tail. The design centres on one
 * fact: a payment is not an event, it is a state with a duration, and the
 * duration is where residents get hurt. A system that credits the ledger on
 * submission tells someone they are square and then quietly un-tells them. This
 * one credits the ledger when money actually settles, reverses it when a bank
 * takes it back, and says so on both occasions.
 *
 * Everything here is idempotent. Providers retry webhooks, jobs re-run, and
 * residents on bad connections tap Pay twice. None of those may produce a second
 * debit or a second ledger row.
 */

import { randomUUID } from "node:crypto";
import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type {
  Payment,
  PaymentMethodKind,
  PaymentStatus,
} from "../../../../packages/shared/src/payments.ts";
import {
  isResidentAttributable,
  residentFailureText,
} from "../../../../packages/shared/src/payments.ts";
import { addDays, today } from "../../../../packages/shared/src/ids.ts";
import type { PaymentProvider, ProviderEvent } from "../providers/payments/index.ts";
import { getBalance, postEntry, reverseEntry } from "./ledger.ts";
import { holdFees } from "./latefees.ts";
import { conflict, unprocessable } from "../http/errors.ts";
import { PostgresError } from "../db/protocol.ts";

const PAYMENT_COLUMNS = `
  p.id, p.tenancy_id, p.amount_cents, p.method, p.status, p.provider, p.provider_reference,
  p.method_label, p.failure_code, p.failure_message, p.receipt_number,
  p.submitted_at::text AS submitted_at, p.settled_at::text AS settled_at,
  p.resolved_at::text AS resolved_at, p.initiated_by_role, p.recorded_by_manager
`;

type PaymentRow = {
  id: string;
  tenancy_id: string;
  amount_cents: number;
  method: PaymentMethodKind;
  status: PaymentStatus;
  provider: string;
  provider_reference: string | null;
  method_label: string | null;
  failure_code: string | null;
  failure_message: string | null;
  receipt_number: string | null;
  submitted_at: string;
  settled_at: string | null;
  resolved_at: string | null;
  initiated_by_role: string | null;
  recorded_by_manager: boolean;
};

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    amountCents: row.amount_cents as Cents,
    method: row.method,
    status: row.status,
    provider: row.provider,
    providerReference: row.provider_reference,
    methodLabel: row.method_label,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    submittedAt: row.submitted_at,
    settledAt: row.settled_at,
    resolvedAt: row.resolved_at,
    initiatedByRole: row.initiated_by_role,
    recordedByManager: row.recorded_by_manager,
    receiptNumber: row.receipt_number,
  };
}

export interface SubmitOptions {
  tenancyId: string;
  amountCents: number;
  paymentMethodId: string;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: string;
  /** What the resident's screen said they owed, if it told them. */
  expectedBalanceCents?: number;
}

export interface SubmitResult {
  payment: Payment;
  deduplicated: boolean;
  balanceCents: Cents;
  /**
   * Bookkeeping the failure of this payment requires, to be applied by the
   * caller under the system context.
   *
   * It is returned rather than done here because `submitPayment` runs inside
   * the *resident's* transaction, and pausing late fees writes an annotation to
   * the ledger — which residents cannot write, correctly. Doing it inline made
   * Row-Level Security refuse the write and roll back the whole transaction, so
   * a declined card produced an error page and no payment record at all. The
   * webhook path already applies consequences under the system context; this
   * makes the submission path do the same.
   */
  failureConsequence: FailureConsequence | null;
}

export interface FailureConsequence {
  tenancyId: string;
  paymentId: string;
  amountCents: number;
  failureCode: string;
  returned: boolean;
  methodLabel: string | null;
}

export interface AuthorizedPayment {
  tenancyId: string;
  amountCents: number;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: string;
  methodId: string;
  methodKind: PaymentMethodKind;
  methodToken: string;
  methodLabel: string;
  balanceCents: Cents;
  /** Set when the key matched an earlier submission; nothing further is done. */
  existing: Payment | null;
}

/**
 * Check that this resident may make this payment, from this method, against
 * this balance.
 *
 * Runs in the *resident's* security context, which is the point: Row-Level
 * Security is what decides whether the tenancy and the payment method are
 * theirs, rather than a WHERE clause somebody has to remember. Everything after
 * this — inserting the payment, calling the processor, moving the payment
 * through its states — is the system acting on the resident's instruction, and
 * runs under the system context in `executePayment`.
 *
 * Splitting the two is not ceremony. Doing the state transitions in the
 * resident's transaction meant RLS silently refused them and payments stayed
 * stuck in `pending`.
 */
export async function authorizePayment(tx: Tx, options: SubmitOptions): Promise<AuthorizedPayment> {
  const existing = await tx.maybeOne<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.idempotency_key = $1`,
    [options.idempotencyKey],
  );

  const balance = await getBalance(tx, options.tenancyId);

  if (existing) {
    return {
      tenancyId: options.tenancyId,
      amountCents: options.amountCents,
      idempotencyKey: options.idempotencyKey,
      actorUserId: options.actorUserId,
      actorRole: options.actorRole,
      methodId: "",
      methodKind: "ach",
      methodToken: "",
      methodLabel: "",
      balanceCents: balance,
      existing: toPayment(existing),
    };
  }

  const method = await tx.maybeOne<{
    id: string;
    kind: PaymentMethodKind;
    provider_token: string;
    institution: string | null;
    brand: string | null;
    last4: string | null;
    verified: boolean;
  }>(
    `SELECT id, kind, provider_token, institution, brand, last4, verified
     FROM payment_methods WHERE id = $1 AND tenancy_id = $2 AND removed_at IS NULL`,
    [options.paymentMethodId, options.tenancyId],
  );
  if (!method) throw unprocessable("That payment method is not available on this account.");

  if (!method.verified) {
    throw unprocessable(
      "This bank account has not finished verification yet. Once your bank confirms it, you can pay from it.",
    );
  }

  // A stale tab must never become an unexpected debit. If the resident's screen
  // said one number and the ledger says another, refuse and make them look.
  if (options.expectedBalanceCents !== undefined && options.expectedBalanceCents !== balance) {
    throw conflict(
      `Your balance changed since this page loaded — it is now $${(balance / 100).toFixed(2)}. ` +
        `Nothing has been charged. Please review the amount and try again.`,
    );
  }

  return {
    tenancyId: options.tenancyId,
    amountCents: options.amountCents,
    idempotencyKey: options.idempotencyKey,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    methodId: method.id,
    methodKind: method.kind,
    methodToken: method.provider_token,
    methodLabel: describeMethod(method.kind, method.institution, method.brand, method.last4),
    balanceCents: balance,
    existing: null,
  };
}

/**
 * Submit a payment.
 *
 * No ledger row is written here. The money has not moved; writing a credit now
 * would be the same lie the incumbent portals tell. What is written is a
 * `payments` row in `processing`, which the resident's balance view shows as
 * pending and which suppresses late-fee accrual for as long as it is in flight.
 *
 * Must run under the system context — see `authorizePayment` for why.
 */
export async function submitPayment(
  tx: Tx,
  provider: PaymentProvider,
  options: SubmitOptions,
): Promise<SubmitResult> {
  // The same key arriving twice is the common case on a flaky connection, not an
  // error. Return the original.
  const existing = await tx.maybeOne<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.idempotency_key = $1`,
    [options.idempotencyKey],
  );
  if (existing) {
    return {
      payment: toPayment(existing),
      deduplicated: true,
      balanceCents: await getBalance(tx, existing.tenancy_id),
      failureConsequence: null,
    };
  }

  const method = await tx.maybeOne<{
    id: string;
    kind: PaymentMethodKind;
    provider_token: string;
    institution: string | null;
    last4: string | null;
    brand: string | null;
    verified: boolean;
    tenancy_id: string;
  }>(
    `SELECT id, kind, provider_token, institution, last4, brand, verified, tenancy_id
     FROM payment_methods WHERE id = $1 AND tenancy_id = $2 AND removed_at IS NULL`,
    [options.paymentMethodId, options.tenancyId],
  );
  if (!method) throw unprocessable("That payment method is not available on this account.");

  if (!method.verified) {
    throw unprocessable(
      "This bank account has not finished verification yet. Once your bank confirms it, you can pay from it.",
    );
  }

  const balance = await getBalance(tx, options.tenancyId);

  // A stale tab must never become an unexpected debit. If the resident's screen
  // said one number and the ledger says another, refuse and make them look.
  if (
    options.expectedBalanceCents !== undefined &&
    options.expectedBalanceCents !== balance
  ) {
    throw conflict(
      `Your balance changed since this page loaded — it is now $${(balance / 100).toFixed(2)}. ` +
        `Nothing has been charged. Please review the amount and try again.`,
    );
  }

  const label = describeMethod(method.kind, method.institution, method.brand, method.last4);

  // Insert, then read back: a data-modifying CTE is invisible to the enclosing
  // query's snapshot in PostgreSQL.
  const insertedPayment = await tx.one<{ id: string }>(
    `INSERT INTO payments (
       organization_id, property_id, tenancy_id, payment_method_id, amount_cents, method,
       status, provider, method_label, idempotency_key, initiated_by_user_id, initiated_by_role
     )
     SELECT t.organization_id, t.property_id, t.id, $2, $3, $4, 'pending', $5, $6, $7, $8, $9
     FROM tenancies t WHERE t.id = $1
     RETURNING id`,
    [
      options.tenancyId, method.id, options.amountCents, method.kind,
      provider.name, label, options.idempotencyKey, options.actorUserId, options.actorRole,
    ],
  );
  const created = await tx.one<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
    [insertedPayment.id],
  );

  let result;
  try {
    result = await provider.charge({
      paymentId: created.id,
      amountCents: options.amountCents,
      method: method.kind,
      providerToken: method.provider_token,
      // The provider's own idempotency key is derived from ours, so a retry that
      // reaches the processor cannot double-charge even if our row was written.
      idempotencyKey: `payment:${created.id}`,
      descriptor: "RENT",
      metadata: { tenancy_id: options.tenancyId, payment_id: created.id },
    });
  } catch (error) {
    // The processor is unreachable or refused the request outright. The payment
    // failed; the resident is told, and nothing was taken.
    const failed = await transition(tx, created.id, "failed", {
      failureCode: "processing_error",
      failureMessage: residentFailureText("processing_error"),
    });
    return {
      payment: failed,
      deduplicated: false,
      balanceCents: balance,
      failureConsequence: consequenceFor(failed, "processing_error"),
    };
  }

  await tx.query("UPDATE payments SET provider_reference = $2 WHERE id = $1", [
    created.id,
    result.providerReference,
  ]);

  if (result.status === "failed") {
    const failed = await transition(tx, created.id, "failed", {
      failureCode: result.failureCode ?? "processing_error",
      failureMessage: residentFailureText(result.failureCode ?? null),
    });
    return {
      payment: failed,
      deduplicated: false,
      balanceCents: balance,
      failureConsequence: consequenceFor(failed, result.failureCode ?? "processing_error"),
    };
  }

  const processing = await transition(tx, created.id, "processing", {});

  return { payment: processing, deduplicated: false, balanceCents: balance, failureConsequence: null };
}

function consequenceFor(payment: Payment, code: string): FailureConsequence {
  return {
    tenancyId: payment.tenancyId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    failureCode: code,
    returned: false,
    methodLabel: payment.methodLabel,
  };
}

/**
 * Apply the consequences of a failed payment. Must run under the system
 * context: it writes to the ledger, which residents cannot do.
 */
export async function applyFailureConsequence(
  tx: Tx,
  consequence: FailureConsequence,
): Promise<Array<{ eventType: string; dedupeKey: string; payload: Record<string, unknown> }>> {
  return onPaymentFailed(
    tx,
    {
      id: consequence.paymentId,
      tenancyId: consequence.tenancyId,
      amountCents: consequence.amountCents as Cents,
      methodLabel: consequence.methodLabel,
    } as Payment,
    consequence.failureCode,
    { returned: consequence.returned },
  );
}

/**
 * Record a payment that arrived outside the portal — a check, cash at the
 * office, a money order.
 *
 * This posts to the ledger immediately, because unlike an electronic debit the
 * money is already in hand. It is attributed to the manager who recorded it and
 * carries their stated reason, so that "I paid in cash and they lost it" has a
 * record on both sides.
 */
export async function recordOfflinePayment(
  tx: Tx,
  options: {
    tenancyId: string;
    amountCents: number;
    method: "check" | "cash" | "money_order";
    receivedOn: string;
    reference?: string;
    reason: string;
    actorUserId: string;
    actorRole: string;
  },
): Promise<{ payment: Payment; balanceCents: Cents }> {
  const idempotencyKey = `offline:${options.tenancyId}:${options.receivedOn}:${options.amountCents}:${options.reference ?? ""}`;

  const existing = await tx.maybeOne<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing) {
    return { payment: toPayment(existing), balanceCents: await getBalance(tx, options.tenancyId) };
  }

  const receipt = await nextReceiptNumber(tx);

  const insertedOffline = await tx.one<{ id: string }>(
    `INSERT INTO payments (
       organization_id, property_id, tenancy_id, amount_cents, method, status, provider,
       method_label, receipt_number, idempotency_key, initiated_by_user_id, initiated_by_role,
       recorded_by_manager, settled_at, resolved_at
     )
     SELECT t.organization_id, t.property_id, t.id, $2, $3, 'settled', 'manual', $4, $5, $6, $7, $8, true, now(), now()
     FROM tenancies t WHERE t.id = $1
     RETURNING id`,
    [
      options.tenancyId,
      options.amountCents,
      options.method,
      `${labelForOfflineMethod(options.method)}${options.reference ? ` #${options.reference}` : ""}`,
      receipt,
      idempotencyKey,
      options.actorUserId,
      options.actorRole,
    ],
  );
  const created = await tx.one<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
    [insertedOffline.id],
  );

  await postEntry(tx, {
    tenancyId: options.tenancyId,
    entryType: "payment",
    category: categoryForMethod(options.method),
    amountCents: -options.amountCents,
    description: `${labelForOfflineMethod(options.method)} payment received${options.reference ? ` (ref ${options.reference})` : ""} — receipt ${receipt}`,
    effectiveDate: options.receivedOn,
    paymentId: created.id,
    actorUserId: options.actorUserId,
    actorRole: options.actorRole,
    actorReason: options.reason,
    idempotencyKey: `payment:${created.id}`,
  });

  return { payment: toPayment(created), balanceCents: await getBalance(tx, options.tenancyId) };
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

export interface ReconcileOutcome {
  payment: Payment | null;
  action: "settled" | "failed" | "returned" | "refunded" | "disputed" | "ignored" | "unknown_payment";
  ledgerEntryId: string | null;
  notify: Array<{ eventType: string; dedupeKey: string; payload: Record<string, unknown> }>;
}

/**
 * Apply one provider event.
 *
 * Called from the webhook receiver after the signature has verified and the
 * event has been recorded. Every branch is idempotent by way of the payment's
 * state machine and the ledger's idempotency keys: an event that has already
 * been applied finds the payment in its destination state and does nothing.
 */
export async function reconcile(tx: Tx, event: ProviderEvent): Promise<ReconcileOutcome> {
  const payment = await findPayment(tx, event);
  if (!payment) return { payment: null, action: "unknown_payment", ledgerEntryId: null, notify: [] };

  switch (event.type) {
    case "payment.settled":
      return settle(tx, payment);
    case "payment.failed":
      return fail(tx, payment, event.failureCode ?? "processing_error");
    case "payment.returned":
      return returnPayment(tx, payment, event.failureCode ?? "insufficient_funds");
    case "payment.refunded":
      return refund(tx, payment, event.amountCents ?? payment.amount_cents);
    case "payment.disputed":
      return dispute(tx, payment);
    default:
      return { payment: toPayment(payment), action: "ignored", ledgerEntryId: null, notify: [] };
  }
}

async function settle(tx: Tx, row: PaymentRow): Promise<ReconcileOutcome> {
  if (row.status === "settled") {
    // Already applied. The provider is retrying; say nothing and send nothing.
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }
  if (row.status !== "processing" && row.status !== "pending") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }

  const receipt = row.receipt_number ?? (await nextReceiptNumber(tx));

  // `pending` can reach `settled` only through `processing`; walk it rather than
  // widening the state machine to accommodate a fast provider.
  if (row.status === "pending") await transition(tx, row.id, "processing", {});

  const settled = await transition(tx, row.id, "settled", { receiptNumber: receipt, settledAt: true });

  const entry = await postEntry(tx, {
    tenancyId: row.tenancy_id,
    entryType: "payment",
    category: row.method === "card" ? "payment_card" : "payment_ach",
    amountCents: -row.amount_cents,
    description: `${row.method === "card" ? "Card" : "Bank"} payment — ${row.method_label ?? "payment method"} — receipt ${receipt}`,
    paymentId: row.id,
    actorRole: "system_job",
    idempotencyKey: `payment:${row.id}`,
  });

  // Money arrived: any pause put in place by an earlier failure has served its
  // purpose.
  await tx.query(
    "UPDATE tenancies SET late_fee_hold_until = NULL, late_fee_hold_reason = NULL WHERE id = $1",
    [row.tenancy_id],
  );

  await applyToPlanInstallments(tx, row.tenancy_id, row.amount_cents);

  const balance = await getBalance(tx, row.tenancy_id);

  return {
    payment: settled,
    action: "settled",
    ledgerEntryId: entry.id,
    notify: [
      {
        eventType: "payment.receipt",
        dedupeKey: `payment.receipt:${row.id}`,
        payload: {
          paymentId: row.id,
          amountCents: row.amount_cents,
          receiptNumber: receipt,
          methodLabel: row.method_label,
          balanceCents: balance,
        },
      },
    ],
  };
}

async function fail(tx: Tx, row: PaymentRow, code: string): Promise<ReconcileOutcome> {
  if (row.status === "failed" || row.status === "returned") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }
  if (row.status === "settled") {
    // A "failure" for money already credited is really a return.
    return returnPayment(tx, row, code);
  }

  const failed = await transition(tx, row.id, "failed", {
    failureCode: code,
    failureMessage: residentFailureText(code),
  });
  const notify = await onPaymentFailed(tx, failed, code);
  return { payment: failed, action: "failed", ledgerEntryId: null, notify };
}

/**
 * An ACH return: the bank takes back money that had already been credited.
 *
 * The ledger credit is reversed rather than deleted, so the resident's history
 * shows both that the payment arrived and that it was taken back, with the date
 * of each. This is the single most confusing event in rent collection and the
 * place where a shared, immutable ledger earns its keep.
 */
async function returnPayment(tx: Tx, row: PaymentRow, code: string): Promise<ReconcileOutcome> {
  if (row.status === "returned") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }
  if (row.status !== "settled" && row.status !== "disputed") {
    return fail(tx, row, code);
  }

  const returned = await transition(tx, row.id, "returned", {
    failureCode: code,
    failureMessage: residentFailureText(code),
    resolvedAt: true,
  });

  const original = await tx.maybeOne<{ id: string }>(
    "SELECT id FROM ledger_entries WHERE payment_id = $1 AND entry_type = 'payment' LIMIT 1",
    [row.id],
  );

  let reversalId: string | null = null;
  if (original) {
    const { reversal } = await reverseEntry(tx, {
      entryId: original.id,
      reason: `Bank returned this payment: ${code.replace(/_/g, " ")}.`,
      actorUserId: null,
      actorRole: "system_job",
      description: `Returned by bank — ${row.method_label ?? "payment"} — ${code.replace(/_/g, " ")}`,
    });
    reversalId = reversal.id;
  }

  const notify = await onPaymentFailed(tx, returned, code, { returned: true });

  return { payment: returned, action: "returned", ledgerEntryId: reversalId, notify };
}

async function refund(tx: Tx, row: PaymentRow, amountCents: number): Promise<ReconcileOutcome> {
  if (row.status === "refunded") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }
  if (row.status !== "settled" && row.status !== "disputed") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }

  const refunded = await transition(tx, row.id, "refunded", { resolvedAt: true });

  const original = await tx.maybeOne<{ id: string }>(
    "SELECT id FROM ledger_entries WHERE payment_id = $1 AND entry_type = 'payment' LIMIT 1",
    [row.id],
  );

  let reversalId: string | null = null;
  if (original) {
    const { reversal } = await reverseEntry(tx, {
      entryId: original.id,
      amountCents: Math.min(amountCents, row.amount_cents),
      reason: "Payment refunded.",
      actorUserId: null,
      actorRole: "system_job",
      description: `Refund of ${row.method_label ?? "payment"}`,
    });
    reversalId = reversal.id;
  }

  return {
    payment: refunded,
    action: "refunded",
    ledgerEntryId: reversalId,
    notify: [
      {
        eventType: "payment.refunded",
        dedupeKey: `payment.refunded:${row.id}`,
        payload: { paymentId: row.id, amountCents },
      },
    ],
  };
}

/**
 * A chargeback. The money is provisionally clawed back but the outcome is not
 * yet known, so the ledger is left alone and a person is told to look at it.
 * Automatically reversing here would move a resident's balance on the strength
 * of a dispute that may well be resolved in their favour.
 */
async function dispute(tx: Tx, row: PaymentRow): Promise<ReconcileOutcome> {
  if (row.status !== "settled") {
    return { payment: toPayment(row), action: "ignored", ledgerEntryId: null, notify: [] };
  }
  const disputed = await transition(tx, row.id, "disputed", {});

  await holdFees(
    tx,
    row.tenancy_id,
    addDays(today(), 30),
    "A card dispute is open on a payment for this account; fee accrual is paused while it is resolved.",
    { idempotencyKey: `hold:dispute:${row.id}` },
  );

  return {
    payment: disputed,
    action: "disputed",
    ledgerEntryId: null,
    notify: [
      {
        eventType: "payment.failed",
        dedupeKey: `payment.disputed:${row.id}`,
        payload: { paymentId: row.id, amountCents: row.amount_cents, disputed: true },
      },
    ],
  };
}

/**
 * The shared consequence of any payment that did not stick.
 *
 * Fee accrual pauses, and both parties are told with a message that says what
 * happened, what it means, and what to do. The pause is not conditional on whose
 * fault it was — a processor outage and an overdrawn account both leave the
 * resident unable to have paid on time, and sorting out blame is a conversation,
 * not something to prejudge with a fee.
 */
async function onPaymentFailed(
  tx: Tx,
  payment: Payment,
  code: string,
  options: { returned?: boolean } = {},
): Promise<Array<{ eventType: string; dedupeKey: string; payload: Record<string, unknown> }>> {
  const graceDays = isResidentAttributable(code) ? 5 : 10;
  const until = addDays(today(), graceDays);

  await holdFees(
    tx,
    payment.tenancyId,
    until,
    options.returned
      ? `A payment of $${(payment.amountCents / 100).toFixed(2)} was returned by the bank. Late fees are paused until ${until} so this can be sorted out.`
      : `A payment of $${(payment.amountCents / 100).toFixed(2)} did not go through. Late fees are paused until ${until}.`,
    { idempotencyKey: `hold:payment:${payment.id}` },
  );

  const eventType = options.returned ? "payment.returned" : "payment.failed";
  return [
    {
      eventType,
      dedupeKey: `${eventType}:${payment.id}`,
      payload: {
        paymentId: payment.id,
        amountCents: payment.amountCents,
        failureCode: code,
        failureMessage: residentFailureText(code),
        feesPausedUntil: until,
        methodLabel: payment.methodLabel,
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function findPayment(tx: Tx, event: ProviderEvent): Promise<PaymentRow | null> {
  if (event.paymentId) {
    const byId = await tx.maybeOne<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
      [event.paymentId],
    );
    if (byId) return byId;
  }
  if (event.providerReference) {
    return tx.maybeOne<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.provider_reference = $1`,
      [event.providerReference],
    );
  }
  return null;
}

async function transition(
  tx: Tx,
  paymentId: string,
  status: PaymentStatus,
  options: {
    failureCode?: string;
    failureMessage?: string;
    receiptNumber?: string;
    settledAt?: boolean;
    resolvedAt?: boolean;
  },
): Promise<Payment> {
  try {
    const updated = await tx.query(
      `UPDATE payments SET
         status = $2,
         failure_code = COALESCE($3, CASE WHEN $2 IN ('failed','returned') THEN failure_code ELSE NULL END),
         failure_message = COALESCE($4, CASE WHEN $2 IN ('failed','returned') THEN failure_message ELSE NULL END),
         receipt_number = COALESCE(receipt_number, $5),
         settled_at = CASE WHEN $6 THEN now() ELSE settled_at END,
         resolved_at = CASE WHEN $7 THEN now() ELSE resolved_at END
       WHERE id = $1`,
      [
        paymentId,
        status,
        options.failureCode ?? null,
        options.failureMessage ?? null,
        options.receiptNumber ?? null,
        options.settledAt ?? false,
        options.resolvedAt ?? false,
      ],
    );

    // Row-Level Security answers a refused UPDATE with zero rows rather than an
    // error. Left unchecked, a payment would silently stay in its old state and
    // the caller would carry on as though it had moved — which is how a
    // declined card ends up recorded as still pending. Fail loudly instead.
    if (updated.rowCount === 0) {
      throw new Error(
        `payment ${paymentId} could not be moved to ${status}: the database refused the update. ` +
          `Payment state changes must run under the system context.`,
      );
    }

    const row = await tx.one<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
      [paymentId],
    );
    return toPayment(row);
  } catch (error) {
    if (error instanceof PostgresError && error.isCheckViolation) {
      throw conflict(error.fields.message ?? "That payment cannot move to that state.");
    }
    throw error;
  }
}

/**
 * Receipt numbers are sequential per year and human-quotable, because a resident
 * reads one over the phone to someone looking it up. A uuid is not a receipt
 * number for the same reason a licence plate is not a uuid.
 */
async function nextReceiptNumber(tx: Tx): Promise<string> {
  const year = new Date().getUTCFullYear();
  const row = await tx.one<{ next: number }>(
    `SELECT COALESCE(max(substring(receipt_number from '[0-9]+$')::int), 0) + 1 AS next
     FROM payments WHERE receipt_number LIKE $1`,
    [`R${year}-%`],
  );
  return `R${year}-${String(row.next).padStart(5, "0")}`;
}

/** Credit a settled payment against any open plan installments, oldest first. */
async function applyToPlanInstallments(tx: Tx, tenancyId: string, amountCents: number): Promise<void> {
  const installments = await tx.many<{ id: string; amount_cents: number; paid_cents: number }>(
    `SELECT i.id, i.amount_cents, i.paid_cents
     FROM payment_plan_installments i
     JOIN payment_plans p ON p.id = i.payment_plan_id
     WHERE i.tenancy_id = $1 AND p.status = 'active' AND i.status IN ('scheduled','partial')
     ORDER BY i.due_date`,
    [tenancyId],
  );

  let remaining = amountCents;
  for (const installment of installments) {
    if (remaining <= 0) break;
    const owed = installment.amount_cents - installment.paid_cents;
    const applied = Math.min(owed, remaining);
    remaining -= applied;
    const paid = installment.paid_cents + applied;
    await tx.query(
      `UPDATE payment_plan_installments
       SET paid_cents = $2, status = CASE WHEN $2 >= amount_cents THEN 'paid' ELSE 'partial' END
       WHERE id = $1`,
      [installment.id, paid],
    );
  }

  await tx.query(
    `UPDATE payment_plans SET status = 'completed', closed_at = now()
     WHERE tenancy_id = $1 AND status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM payment_plan_installments i
         WHERE i.payment_plan_id = payment_plans.id AND i.status <> 'paid'
       )`,
    [tenancyId],
  );
}

function describeMethod(
  kind: PaymentMethodKind,
  institution: string | null,
  brand: string | null,
  last4: string | null,
): string {
  const name = institution ?? brand ?? (kind === "ach" ? "Bank account" : "Card");
  return last4 ? `${name} ••••${last4}` : name;
}

function labelForOfflineMethod(method: string): string {
  return method === "check" ? "Check" : method === "cash" ? "Cash" : "Money order";
}

function categoryForMethod(method: string) {
  return method === "check" ? "payment_check" : method === "cash" ? "payment_cash" : "payment_money_order";
}

export async function getPayment(tx: Tx, paymentId: string): Promise<Payment | null> {
  const row = await tx.maybeOne<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`,
    [paymentId],
  );
  return row ? toPayment(row) : null;
}

export async function listPayments(tx: Tx, tenancyId: string, limit = 50): Promise<Payment[]> {
  const rows = await tx.many<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.tenancy_id = $1
     ORDER BY p.submitted_at DESC LIMIT $2`,
    [tenancyId, limit],
  );
  return rows.map(toPayment);
}

export async function listPendingPayments(tx: Tx, tenancyId: string): Promise<Payment[]> {
  const rows = await tx.many<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p
     WHERE p.tenancy_id = $1 AND p.status IN ('pending','processing')
     ORDER BY p.submitted_at DESC`,
    [tenancyId],
  );
  return rows.map(toPayment);
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
