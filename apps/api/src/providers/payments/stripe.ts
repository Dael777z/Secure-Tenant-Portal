/**
 * Stripe, over the REST API directly.
 *
 * No SDK, for the same reason there is no ORM and no framework: this process
 * runs on a property manager's own hardware, and the dependency they cannot
 * audit is the one that hurts them. The surface actually used here is four
 * endpoints and one signature check.
 *
 * ACH in Stripe's model is `us_bank_account`, which behaves the way ACH really
 * behaves — a PaymentIntent goes to `processing` and reaches `succeeded` days
 * later, and can still be reversed after that by a return. The webhook handler
 * treats `charge.dispute.created` and the ACH failure events as first-class
 * rather than as edge cases, because for a rent ledger they are neither rare nor
 * cosmetic.
 *
 * Configuration: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Bank verification is
 * Plaid's `processor_token` exchange (see plaid.ts) or Stripe's own micro-deposit
 * flow; either produces the payment-method token this module expects.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  ProviderEvent,
  RefundRequest,
  TokenizeRequest,
  TokenizeResult,
} from "./index.ts";
import type { PaymentStatus } from "../../../../../packages/shared/src/payments.ts";

const API_BASE = "https://api.stripe.com/v1";

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** Rejected outside this window, which is what makes replay a non-issue. */
  toleranceSeconds?: number;
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  readonly isSimulated = false;

  private readonly options: StripeOptions;

  constructor(options: StripeOptions) {
    if (!options.secretKey) throw new Error("STRIPE_SECRET_KEY is required to use the Stripe provider");
    this.options = { toleranceSeconds: 300, ...options };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const body: Record<string, string> = {
      amount: String(request.amountCents),
      currency: "usd",
      confirm: "true",
      payment_method: request.providerToken,
      "payment_method_types[0]": request.method === "ach" ? "us_bank_account" : "card",
      // Off-session: the resident may have closed the tab, and for autopay they
      // are definitionally not present.
      off_session: "true",
      description: request.descriptor,
      statement_descriptor_suffix: request.descriptor.slice(0, 22),
      "metadata[payment_id]": request.paymentId,
    };
    for (const [key, value] of Object.entries(request.metadata)) {
      body[`metadata[${key}]`] = value;
    }

    // Stripe honours this key for 24 hours: a retried request returns the
    // original intent instead of creating a second charge.
    const intent = await this.request("POST", "/payment_intents", body, request.idempotencyKey);

    return {
      providerReference: String(intent.id),
      status: mapIntentStatus(String(intent.status)),
      failureCode: intent.last_payment_error
        ? mapFailureCode(String((intent.last_payment_error as Record<string, unknown>).code ?? ""))
        : undefined,
      failureMessage: intent.last_payment_error
        ? String((intent.last_payment_error as Record<string, unknown>).message ?? "")
        : undefined,
    };
  }

  async refund(request: RefundRequest): Promise<{ providerReference: string }> {
    const refund = await this.request(
      "POST",
      "/refunds",
      {
        payment_intent: request.providerReference,
        amount: String(request.amountCents),
        reason: "requested_by_customer",
        "metadata[reason]": request.reason.slice(0, 480),
      },
      request.idempotencyKey,
    );
    return { providerReference: String(refund.id) };
  }

  /**
   * Attach a payment method collected client-side to a customer. The raw card
   * number and full account number never reach this server — the browser sends
   * them to Stripe directly and receives a token — which is what keeps a
   * self-hosted operator at SAQ-A rather than in full PCI scope.
   */
  async tokenize(request: TokenizeRequest): Promise<TokenizeResult> {
    const method = await this.request("GET", `/payment_methods/${request.providerToken}`, null);

    if (request.kind === "card") {
      const card = (method.card ?? {}) as Record<string, unknown>;
      return {
        providerToken: String(method.id),
        institution: null,
        last4: card.last4 ? String(card.last4) : null,
        brand: card.brand ? String(card.brand) : null,
        expMonth: card.exp_month ? Number(card.exp_month) : null,
        expYear: card.exp_year ? Number(card.exp_year) : null,
        verified: true,
      };
    }

    const bank = (method.us_bank_account ?? {}) as Record<string, unknown>;
    return {
      providerToken: String(method.id),
      institution: bank.bank_name ? String(bank.bank_name) : null,
      last4: bank.last4 ? String(bank.last4) : null,
      brand: null,
      expMonth: null,
      expYear: null,
      // A bank account is usable only once ownership is proven, by Plaid or by
      // micro-deposits. Treating an unverified account as verified is how an
      // operator collects returns for a month.
      verified: String(bank.status ?? "") === "verified",
    };
  }

  simulatedMicrodeposits(): null {
    return null;
  }

  /**
   * Stripe verifies micro-deposits on the SetupIntent that attached the bank
   * account, not on the PaymentMethod, so find that intent first. Stripe
   * answers a wrong pair with a 400; that is a "no", not an outage.
   */
  async verifyMicrodeposits(request: { providerToken: string; amountsCents: [number, number] }): Promise<boolean> {
    const intents = await this.request("GET", `/setup_intents?payment_method=${encodeURIComponent(request.providerToken)}&limit=1`, null);
    const intent = ((intents.data as Array<Record<string, unknown>>) ?? [])[0];
    if (!intent) return false;
    try {
      const result = await this.request("POST", `/setup_intents/${intent.id}/verify_microdeposits`, {
        "amounts[0]": String(request.amountsCents[0]),
        "amounts[1]": String(request.amountsCents[1]),
      });
      return String(result.status ?? "") === "succeeded";
    } catch (error) {
      if (error instanceof Error && /400|amounts/i.test(error.message)) return false;
      throw error;
    }
  }

  /**
   * Verify per Stripe's `Stripe-Signature` scheme: `t=<unix>,v1=<hex hmac>` over
   * `<t>.<raw body>`. The raw body matters — parsing and re-serializing the JSON
   * first changes the bytes and the signature will never match.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ProviderEvent | null {
    const header = String(headers["stripe-signature"] ?? "");
    if (!header) return null;

    const parts: Record<string, string> = {};
    for (const item of header.split(",")) {
      const [key, value] = item.split("=");
      if (key && value) parts[key.trim()] = value.trim();
    }

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return null;

    const age = Math.abs(Date.now() / 1000 - timestamp);
    if (age > (this.options.toleranceSeconds ?? 300)) return null;

    const expected = createHmac("sha256", this.options.webhookSecret)
      .update(`${parts.t}.${rawBody.toString("utf8")}`)
      .digest("hex");
    const provided = parts.v1 ?? "";
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }

    const data = ((parsed.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;

    return {
      providerEventId: String(parsed.id ?? ""),
      type: mapEventType(String(parsed.type ?? "")),
      providerReference: String(data.payment_intent ?? data.id ?? "") || null,
      paymentId: metadata.payment_id ? String(metadata.payment_id) : null,
      amountCents: typeof data.amount === "number" ? data.amount : null,
      failureCode: data.failure_code
        ? mapFailureCode(String(data.failure_code))
        : data.last_payment_error
          ? mapFailureCode(String((data.last_payment_error as Record<string, unknown>).code ?? ""))
          : null,
      raw: parsed,
    };
  }

  private async request(
    method: string,
    path: string,
    body: Record<string, string> | null,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.secretKey}`,
      "stripe-version": "2024-06-20",
    };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? new URLSearchParams(body).toString() : undefined,
    });

    const payload = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const error = (payload.error ?? {}) as Record<string, unknown>;
      throw new StripeApiError(
        String(error.message ?? `Stripe returned ${response.status}`),
        String(error.code ?? "stripe_error"),
        response.status,
      );
    }

    return payload;
  }
}

export class StripeApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "StripeApiError";
    this.code = code;
    this.status = status;
  }
}

function mapIntentStatus(status: string): PaymentStatus {
  switch (status) {
    case "succeeded":
      return "settled";
    case "processing":
    case "requires_capture":
      return "processing";
    case "requires_payment_method":
    case "canceled":
      return "failed";
    default:
      return "pending";
  }
}

function mapEventType(type: string): ProviderEvent["type"] {
  switch (type) {
    case "payment_intent.succeeded":
    case "charge.succeeded":
      return "payment.settled";
    case "payment_intent.payment_failed":
    case "charge.failed":
      return "payment.failed";
    // An ACH return arrives days after the money appeared to be collected.
    case "charge.refunded":
      return "payment.refunded";
    case "charge.dispute.created":
      return "payment.disputed";
    case "payment_intent.canceled":
      return "payment.failed";
    case "charge.refund.updated":
      return "payment.refunded";
    default:
      return "unknown";
  }
}

/** Stripe's codes, mapped into the one vocabulary the resident-facing copy uses. */
function mapFailureCode(code: string): string {
  const map: Record<string, string> = {
    insufficient_funds: "insufficient_funds",
    account_closed: "account_closed",
    no_account: "no_account",
    debit_not_authorized: "unauthorized",
    payment_method_not_available: "processing_error",
    card_declined: "card_declined",
    expired_card: "expired_card",
    incorrect_cvc: "card_declined",
    processing_error: "processing_error",
    authentication_required: "card_declined",
  };
  return map[code] ?? "processing_error";
}
