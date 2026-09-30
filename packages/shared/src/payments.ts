import type { Cents } from "./money.ts";
import type { Uuid } from "./ids.ts";

/**
 * Payment lifecycle.
 *
 * The important property of this state machine is that "paid" has a tail. A card
 * authorization fails in seconds; an ACH debit settles in days and can be
 * returned days after that. A system that treats submission as payment will tell
 * a resident they are square and then quietly un-tell them, which is the failure
 * mode this component is built around rather than around the happy path.
 */

export const PAYMENT_METHODS = ["ach", "card", "check", "cash", "money_order"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHODS)[number];

/** Methods a resident submits themselves; the rest are recorded by a manager. */
export const SELF_SERVICE_METHODS: readonly PaymentMethodKind[] = ["ach", "card"];

export const PAYMENT_STATUSES = [
  "pending",
  "processing",
  "settled",
  "failed",
  "returned",
  "refunded",
  "disputed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly PaymentStatus[] = ["failed", "returned", "refunded"];

/** Statuses in which the money is credited to the ledger right now. */
export const CREDITING_STATUSES: readonly PaymentStatus[] = ["settled", "disputed"];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["processing", "failed"],
  processing: ["settled", "failed"],
  // An ACH return or a chargeback arrives after the money has already been
  // credited, which is why both are reachable from `settled`.
  settled: ["returned", "refunded", "disputed"],
  disputed: ["settled", "refunded"],
  failed: [],
  returned: [],
  refunded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal payment transition ${from} -> ${to}`);
  }
}

export interface PaymentMethodSummary {
  id: Uuid;
  kind: PaymentMethodKind;
  /** "Chase ****4021" — enough to recognize, never enough to reconstruct. */
  label: string;
  last4: string | null;
  institution: string | null;
  verified: boolean;
  isAutopayDefault: boolean;
  addedAt: string;
  /** Three wrong micro-deposit tries lock the account until the office reviews it. */
  verificationLocked: boolean;
  /** Tries left before the lock. */
  verificationAttemptsLeft: number;
  /**
   * Simulated provider only: the deposit amounts in cents, shown so a demo can
   * finish verification. Always null with a real processor.
   */
  simulatedDepositsCents: [number, number] | null;
}

export interface Payment {
  id: Uuid;
  tenancyId: Uuid;
  amountCents: Cents;
  method: PaymentMethodKind;
  status: PaymentStatus;
  provider: string;
  providerReference: string | null;
  methodLabel: string | null;
  failureCode: string | null;
  /** Plain-language, resident-facing. "Your bank returned this as insufficient funds." */
  failureMessage: string | null;
  submittedAt: string;
  settledAt: string | null;
  resolvedAt: string | null;
  initiatedByRole: string | null;
  /** True when a manager recorded this on the resident's behalf (a check, cash). */
  recordedByManager: boolean;
  receiptNumber: string | null;
}

/**
 * Failure codes we map from any provider into one vocabulary, each with text
 * written to be read by a worried person rather than by an engineer. The
 * proposal makes comprehension of these messages an evaluated criterion.
 */
export const FAILURE_CODES = {
  insufficient_funds: {
    resident:
      "Your bank returned this payment for insufficient funds. Nothing was taken from your account, and the amount has been added back to your balance.",
    manager: "ACH return R01 — insufficient funds.",
  },
  account_closed: {
    resident:
      "Your bank reported that this account is closed, so the payment could not complete. Please add a different account or card.",
    manager: "ACH return R02 — account closed.",
  },
  no_account: {
    resident:
      "Your bank could not find this account. Please check the account details or add a different payment method.",
    manager: "ACH return R03 — no account or unable to locate.",
  },
  unauthorized: {
    resident:
      "Your bank flagged this debit as unauthorized and reversed it. If you did authorize it, contacting your bank will usually clear the block.",
    manager: "ACH return R10 — customer advises unauthorized.",
  },
  card_declined: {
    resident:
      "Your card issuer declined this payment. Nothing was charged. A different card, or your bank account, will usually work.",
    manager: "Card declined by issuer.",
  },
  expired_card: {
    resident: "This card has expired, so the payment could not go through. Please update the expiration date or add a new card.",
    manager: "Card expired.",
  },
  processing_error: {
    resident:
      "Something went wrong on the payment network's side, not with your account. Nothing was charged. Trying again usually works.",
    manager: "Processor error — retryable.",
  },
} as const;

export type FailureCode = keyof typeof FAILURE_CODES;

export function residentFailureText(code: string | null): string {
  if (code && code in FAILURE_CODES) return FAILURE_CODES[code as FailureCode].resident;
  return "This payment did not complete. Nothing was taken from your account, and the amount has been added back to your balance.";
}

/**
 * Whether a failure was the resident's bank saying no, or the machinery
 * misbehaving. Only the first kind should ever contribute to a fee, and even
 * then only if the manager has configured one.
 */
export function isResidentAttributable(code: string | null): boolean {
  return code === "insufficient_funds" || code === "unauthorized";
}

export interface AutopayEnrollment {
  id: Uuid;
  tenancyId: Uuid;
  paymentMethodId: Uuid;
  methodLabel: string;
  dayOfMonth: number;
  /**
   * A ceiling the resident sets. An autopay that will draft any amount the
   * ledger names is a standing authorization to empty someone's account after a
   * billing mistake; the cap makes the resident's exposure explicit and bounded.
   */
  capCents: Cents | null;
  active: boolean;
  /** On a shared lease: who set this up, and whether it was the person looking. */
  setUpByName?: string | null;
  setUpByMe?: boolean;
  setUpByUserId?: Uuid;
  /**
   * Split rent (021). Null: this autopay drafts the whole balance. Otherwise
   * it drafts this person's share each month, from their own bank account.
   */
  shareCents?: Cents | null;
  /** For a share: what the person already paid by hand since their last draft, taken off this draft. */
  paidByHandThisCycleCents?: Cents;
  nextDraftDate: string | null;
  nextDraftAmountCents: Cents | null;
  /** Set when the next draft would exceed the cap, so the client can say so plainly. */
  nextDraftBlockedReason: string | null;
  createdAt: string;
}

export const PAYMENT_PLAN_STATUSES = ["active", "completed", "defaulted", "cancelled"] as const;
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUSES)[number];

export interface PaymentPlanInstallment {
  id: Uuid;
  dueDate: string;
  amountCents: Cents;
  paidCents: Cents;
  status: "scheduled" | "paid" | "partial" | "missed";
}

export interface PaymentPlan {
  id: Uuid;
  tenancyId: Uuid;
  totalCents: Cents;
  status: PaymentPlanStatus;
  reason: string;
  openedByName: string | null;
  openedAt: string;
  /** While a plan is active, late-fee accrual is suspended for the covered amount. */
  suspendsLateFees: boolean;
  installments: PaymentPlanInstallment[];
}
