/**
 * A simulated payment provider.
 *
 * This exists so that the failure paths are exercisable — routinely, in CI, on a
 * laptop with no network. The proposal budgets the second half of a sprint for
 * failure handling specifically because that tail is where the incumbent
 * products' resident experience is worst; a provider that only ever succeeds
 * would let all of that code ship untested.
 *
 * What it simulates:
 *
 *   Card decisions arrive synchronously, as they do in reality.
 *   ACH debits settle after a delay, then may be returned days later.
 *   Deterministic triggers: an amount ending in .01 always declines, .02 always
 *   returns after settling, .03 becomes a chargeback. Seeded demo data uses
 *   these so a manager's exception queue has something real in it and a
 *   usability session can be run against a known scenario.
 *
 * It refuses to run in production; see config.ts.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  ProviderEvent,
  RefundRequest,
  TokenizeRequest,
  TokenizeResult,
} from "./index.ts";

export interface MockOptions {
  /** How long a simulated ACH debit takes to settle. */
  settleMs: number;
  /** Fraction of otherwise-successful ACH debits returned later, 0–1. */
  returnRate: number;
  /** Called when the simulated provider decides something asynchronously. */
  emit: (event: ProviderEvent) => void;
  secret: string;
  /**
   * Floor under every scheduled event. Defaults to MIN_EVENT_DELAY_MS, which
   * keeps an event from outrunning the commit of the transaction that caused it
   * when the provider runs in-process. Tests that capture events and drive the
   * clock themselves set 0, since no commit race exists for them.
   */
  minEventDelayMs?: number;
}

/** Below this, an event can outrun the commit of the transaction that caused it. */
const MIN_EVENT_DELAY_MS = 250;

/** Deterministic outcomes, keyed by the cents portion of the amount. */
const TRIGGERS: Record<number, { code: string; kind: "decline" | "return" | "dispute" }> = {
  1: { code: "card_declined", kind: "decline" },
  2: { code: "insufficient_funds", kind: "return" },
  3: { code: "unauthorized", kind: "dispute" },
  4: { code: "account_closed", kind: "decline" },
  5: { code: "processing_error", kind: "decline" },
};

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly isSimulated = true;

  private readonly options: MockOptions;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(options: MockOptions) {
    this.options = options;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const reference = `mock_${randomUUID()}`;
    const trigger = TRIGGERS[request.amountCents % 100];

    if (trigger?.kind === "decline") {
      return {
        providerReference: reference,
        status: "failed",
        failureCode: trigger.code,
        failureMessage: `Simulated ${trigger.code}.`,
      };
    }

    if (request.method === "card") {
      // Cards decide now. There is no settlement tail to model.
      this.schedule(0, {
        providerEventId: `evt_${randomUUID()}`,
        type: "payment.settled",
        providerReference: reference,
        paymentId: request.paymentId,
        amountCents: request.amountCents,
        failureCode: null,
        raw: { simulated: true, method: "card" },
      });
      return { providerReference: reference, status: "processing" };
    }

    // ACH: settles after a delay, and only then can be returned. Modelling the
    // gap is the point — it is where "paid" stops being a single moment.
    this.schedule(this.options.settleMs, {
      providerEventId: `evt_${randomUUID()}`,
      type: "payment.settled",
      providerReference: reference,
      paymentId: request.paymentId,
      amountCents: request.amountCents,
      failureCode: null,
      raw: { simulated: true, method: "ach" },
    });

    const willReturn = trigger?.kind === "return" || Math.random() < this.options.returnRate;
    if (willReturn) {
      this.schedule(this.options.settleMs * 3, {
        providerEventId: `evt_${randomUUID()}`,
        type: "payment.returned",
        providerReference: reference,
        paymentId: request.paymentId,
        amountCents: request.amountCents,
        failureCode: trigger?.code ?? "insufficient_funds",
        raw: { simulated: true, returned: true },
      });
    }

    if (trigger?.kind === "dispute") {
      this.schedule(this.options.settleMs * 4, {
        providerEventId: `evt_${randomUUID()}`,
        type: "payment.disputed",
        providerReference: reference,
        paymentId: request.paymentId,
        amountCents: request.amountCents,
        failureCode: trigger.code,
        raw: { simulated: true, disputed: true },
      });
    }

    return { providerReference: reference, status: "processing" };
  }

  async refund(request: RefundRequest): Promise<{ providerReference: string }> {
    const reference = `mock_refund_${randomUUID()}`;
    this.schedule(0, {
      providerEventId: `evt_${randomUUID()}`,
      type: "payment.refunded",
      providerReference: request.providerReference,
      paymentId: null,
      amountCents: request.amountCents,
      failureCode: null,
      raw: { simulated: true, refund: reference },
    });
    return { providerReference: reference };
  }

  async tokenize(request: TokenizeRequest): Promise<TokenizeResult> {
    const digits = String(Math.abs(hashString(request.providerToken)) % 10000).padStart(4, "0");
    return {
      providerToken: `mock_tok_${hashString(request.providerToken).toString(16)}`,
      institution: request.kind === "ach" ? "Simulated Savings & Loan" : null,
      last4: digits,
      brand: request.kind === "card" ? "Simulated" : null,
      expMonth: request.kind === "card" ? 12 : null,
      expYear: request.kind === "card" ? new Date().getUTCFullYear() + 3 : null,
      // ACH begins unverified, matching a real micro-deposit or Plaid flow.
      verified: request.kind === "card",
    };
  }

  /** Two deposits between $0.10 and $0.98, fixed per account so a demo can read them back. */
  simulatedMicrodeposits(providerToken: string): [number, number] {
    const h = Math.abs(hashString(`deposits:${providerToken}`));
    return [10 + (h % 89), 10 + (Math.floor(h / 89) % 89)];
  }

  async verifyMicrodeposits(request: { providerToken: string; amountsCents: [number, number] }): Promise<boolean> {
    const expected = [...this.simulatedMicrodeposits(request.providerToken)].sort((a, b) => a - b);
    const given = [...request.amountsCents].sort((a, b) => a - b);
    return expected[0] === given[0] && expected[1] === given[1];
  }

  /**
   * Signed even though it is simulated. A test webhook that skips verification
   * lets the receiver ship with the check untested, which is the one bug in this
   * area that actually matters.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent | null {
    const signature = String(headers["x-mock-signature"] ?? "");
    const expected = createHmac("sha256", this.options.secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      return {
        providerEventId: String(parsed.id ?? randomUUID()),
        type: parsed.type ?? "unknown",
        providerReference: parsed.providerReference ?? null,
        paymentId: parsed.paymentId ?? null,
        amountCents: parsed.amountCents ?? null,
        failureCode: parsed.failureCode ?? null,
        raw: parsed,
      };
    } catch {
      return null;
    }
  }

  sign(body: Buffer): string {
    return createHmac("sha256", this.options.secret).update(body).digest("hex");
  }

  /**
   * A floor under every scheduled event.
   *
   * With a zero delay, a card settlement fires on the next tick — which is
   * before the transaction that created the payment has committed, so the
   * handler looks for a row that is not there yet and drops the event. A real
   * processor's webhook always arrives over the network, comfortably after the
   * response has been sent, so this is a fidelity bug in the simulation rather
   * than a property of the system; the floor restores the ordering reality has.
   * The reconciliation path also retries an unknown payment, so neither side
   * depends on this alone.
   */
  private schedule(delayMs: number, event: ProviderEvent): void {
    const floor = this.options.minEventDelayMs ?? MIN_EVENT_DELAY_MS;
    if (floor === 0 && delayMs <= 0) {
      // Captured, not dispatched: the caller owns the clock.
      this.options.emit(event);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.options.emit(event);
    }, Math.max(this.options.minEventDelayMs ?? MIN_EVENT_DELAY_MS, delayMs));
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Used by tests to run the settlement tail without waiting for wall clock. */
  flush(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  stop(): void {
    this.flush();
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
