/**
 * The payment provider interface.
 *
 * Two implementations ship: `stripe`, which moves real money, and `mock`, which
 * simulates the whole lifecycle including the parts that are hard to reach in a
 * sandbox — an ACH debit that settles on Thursday and is returned the following
 * Monday, a card that declines, a chargeback.
 *
 * The interface is narrow on purpose. A provider can create a charge, refund
 * one, and turn its own webhook into an event this system understands. It does
 * not decide anything about the ledger. That asymmetry is what keeps the
 * reconciliation logic testable without a network, and what makes swapping
 * processors a matter of writing one file rather than auditing the codebase.
 */

import type { PaymentMethodKind, PaymentStatus } from "../../../../../packages/shared/src/payments.ts";

export interface ChargeRequest {
  paymentId: string;
  amountCents: number;
  method: PaymentMethodKind;
  providerToken: string;
  /** Passed to the provider so that a retried request cannot double-charge. */
  idempotencyKey: string;
  descriptor: string;
  metadata: Record<string, string>;
}

export interface ChargeResult {
  providerReference: string;
  status: PaymentStatus;
  /** Populated when the provider decided immediately, as cards usually do. */
  failureCode?: string;
  failureMessage?: string;
}

export interface RefundRequest {
  providerReference: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export interface TokenizeRequest {
  kind: PaymentMethodKind;
  providerToken: string;
  tenancyId: string;
}

export interface TokenizeResult {
  providerToken: string;
  institution: string | null;
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  verified: boolean;
}

/**
 * A provider event, normalized. Everything a provider can tell us about a
 * payment after the fact reduces to one of these, which is why the
 * reconciliation code has one shape rather than one per processor.
 */
export interface ProviderEvent {
  providerEventId: string;
  type:
    | "payment.settled"
    | "payment.failed"
    | "payment.returned"
    | "payment.refunded"
    | "payment.disputed"
    | "unknown";
  providerReference: string | null;
  paymentId: string | null;
  amountCents: number | null;
  failureCode: string | null;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  /** True when this provider does not move real money. Surfaced in the UI. */
  readonly isSimulated: boolean;

  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<{ providerReference: string }>;
  tokenize(request: TokenizeRequest): Promise<TokenizeResult>;

  /**
   * Confirm a bank account with the two small deposits the processor sent to
   * it. Returns false for wrong amounts; throws only when the processor could
   * not be asked.
   */
  verifyMicrodeposits(request: { providerToken: string; amountsCents: [number, number] }): Promise<boolean>;

  /**
   * Simulated providers only: the deposit amounts, so a demo can finish the
   * flow without a real bank statement. Real providers return null.
   */
  simulatedMicrodeposits(providerToken: string): [number, number] | null;

  /**
   * Verify a webhook's signature and decode it. Returning `null` means the
   * signature did not verify, and the caller must treat the request as hostile
   * rather than as a malformed friend.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent | null;
}
