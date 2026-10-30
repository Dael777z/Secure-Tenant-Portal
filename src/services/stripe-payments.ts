import { runAs, SYSTEM } from "../db/identity"
import { silentLogger, type LogService } from "../logging"
import { AppError } from "../types/errors"
import type { PaymentState, StripePaymentRecord } from "../types/records"
import type { LeaseStore, StripePaymentStore } from "../types/stores"
import { tenantIdOf } from "../utils/user-id"
import { CASH_APP_FEE, feeFor, type FeeRate } from "./fees"
import { localDate } from "./ledger"
import type { StripeGateway, StripeIntent } from "./stripe"

/**
 * Rent paid with Cash App Pay, through Stripe (006).
 *
 *   1. start     the tenant picks Cash App Pay: a PaymentIntent for the amount plus the
 *                processing fee (fees.ts), and a 'pending' Payment on their lease (not on
 *                the balance yet)
 *   2. confirm   the browser hands the PaymentIntent to Stripe.js, which shows the
 *                Cash App QR code (desktop) or opens Cash App (phone)
 *   3. settle    Stripe's webhook (or the tenant's page, coming back) says how it went:
 *                succeeded → 'completed', on the ledger with the fee as its own charge
 *                (so the balance drops by exactly the rent); canceled → 'failed'
 *
 * The ledger only trusts Stripe itself: every status is read fresh from Stripe's API,
 * never from the browser or the webhook body, and a payment only completes when the
 * amount received is exactly the amount asked for. Refunds made in Stripe come back
 * through the webhook as 'refund' rows.
 */

export const CASH_APP_METHOD = "Cash App Pay"

/** What a PaymentIntent's state means for the ledger, given the amount the checkout asked for. */
export function ledgerStatusFor(intent: StripeIntent, amountCents: number): { status: PaymentState; problem: string | null } {
    if (intent.status === "succeeded") {
        if (intent.amountReceivedCents === amountCents && intent.currency === "usd") return { status: "completed", problem: null }
        // Never seen in practice; if it happens, a person decides (the row stays pending, off the balance).
        return { status: "pending", problem: `received ${intent.amountReceivedCents} ${intent.currency}, expected ${amountCents} usd` }
    }
    if (intent.status === "canceled") return { status: "failed", problem: null }
    // requires_payment_method (declined: the tenant can try again), requires_action, processing
    return { status: "pending", problem: null }
}

export interface CashAppCheckout {
    paymentIntentId: string
    clientSecret: string
    /** The processing fee added (007), and what Cash App charges: rent + fee. */
    fee: number
    total: number
}

export class StripePaymentService {
    constructor(
        private readonly db: StripePaymentStore & Pick<LeaseStore, "findCurrentLease">,
        private readonly stripe: StripeGateway | null,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    get publishableKey(): string | null {
        return this.stripe?.publishableKey ?? null
    }

    /** The fee rate the tenant pays on top (null when Cash App Pay is off), for the pay page. */
    get cashAppFee(): FeeRate | null {
        return this.stripe ? CASH_APP_FEE : null
    }

    private gateway(): StripeGateway {
        if (!this.stripe) throw new AppError("STRIPE_NOT_CONFIGURED")
        return this.stripe
    }

    // ---- The tenant

    /**
     * Start (or pick up again) a Cash App checkout paying `amount` toward the tenant's current lease.
     * Cash App charges `amount` + the processing fee (fees.ts), worked out here, never by the browser.
     * The same `idempotencyKey` returns the same PaymentIntent, so a double click or a retry
     * after a decline never makes a second payment.
     */
    // logs payment.cashapp.start.succeeded { userId, amount, leaseId, paymentIntentId } or .failed
    startCashApp(userId: string, input: { amount: number; idempotencyKey: string }): Promise<CashAppCheckout> {
        const facts: { leaseId?: number; paymentIntentId?: string; fee?: number } = {}
        return this.log.flow("payment.cashapp.start", { userId, amount: input.amount }, async () => {
            const stripe = this.gateway()
            const tID = tenantIdOf(userId)
            const lease = await this.db.findCurrentLease(tID, localDate(new Date(), this.timeZone))
            if (!lease) throw new AppError("NO_ACTIVE_LEASE")
            facts.leaseId = lease.id
            const { feeCents, totalCents } = feeFor(Math.round(input.amount * 100), CASH_APP_FEE)
            facts.fee = feeCents / 100
            const checkout = (intent: StripeIntent): CashAppCheckout =>
                ({ paymentIntentId: intent.id, clientSecret: intent.clientSecret!, fee: feeCents / 100, total: totalCents / 100 })
            // Scoped to the tenant, so one tenant's key can never match another's payment.
            const key = `tenant:${tID}:${input.idempotencyKey}`

            const earlier = await this.db.findStripeCheckout(lease.id, key)
            if (earlier) {
                facts.paymentIntentId = earlier.paymentIntentId
                if (earlier.amountCents !== totalCents) throw new AppError("CHECKOUT_AMOUNT_CHANGED")
                return checkout(await stripe.retrieveIntent(earlier.paymentIntentId))
            }

            // Stripe's own idempotency key: if saving below fails, the retry gets this same PaymentIntent back.
            const intent = await stripe.createCashAppIntent({
                amountCents: totalCents,
                description: `Rent - Unit ${lease.unitNum}, ${lease.propertyName} (incl. $${(feeCents / 100).toFixed(2)} processing fee)`,
                metadata: { leaseId: String(lease.id), tenantId: String(tID), rentCents: String(totalCents - feeCents), feeCents: String(feeCents) },
                idempotencyKey: `cashapp:${key}:${totalCents}`,
            })
            facts.paymentIntentId = intent.id
            const saved = await this.db.createStripePayment({
                leaseId: lease.id, tenantId: tID, amount: totalCents / 100, feeCents, paymentIntentId: intent.id, methodType: "cashapp",
                method: CASH_APP_METHOD, stripeStatus: intent.status, idempotencyKey: key,
            })
            // A racing request saved its own PaymentIntent first: use that one.
            if (saved.paymentIntentId !== intent.id) {
                facts.paymentIntentId = saved.paymentIntentId
                return checkout(await stripe.retrieveIntent(saved.paymentIntentId))
            }
            return checkout(intent)
        }, () => ({ ...facts }))
    }

    /**
     * The tenant's page is back from Cash App (or the QR code closed): read the payment's state
     * from Stripe now, so the page does not have to wait for the webhook. Only their own payments.
     */
    async refreshForTenant(paymentIntentId: string): Promise<{ status: PaymentState; confirmation: string }> {
        // As the tenant: RLS finds only payments on their own leases.
        if (!(await this.db.findStripePayment(paymentIntentId))) throw new AppError("NOT_FOUND")
        const payment = await this.sync(paymentIntentId)
        if (!payment) throw new AppError("NOT_FOUND")
        return { status: payment.status, confirmation: payment.paymentIntentId }
    }

    // ---- Stripe's webhook

    /** Verify, act, record. Throws (so Stripe retries) when something is broken; unknown events are ignored. */
    async handleWebhook(rawBody: Buffer | string, signature: string): Promise<void> {
        const event = this.gateway().verifyWebhook(rawBody, signature)
        await runAs(SYSTEM, () => this.log.flow("stripe.webhook", { eventId: event.id, type: event.type, paymentIntentId: event.paymentIntentId }, async () => {
            if (!event.paymentIntentId) return
            if (event.type.startsWith("payment_intent.")) await this.sync(event.paymentIntentId)
            else if (event.type === "charge.refunded" || event.type === "charge.refund.updated") await this.syncRefunds(event.paymentIntentId)
            else return
            await this.db.recordStripeEvent(event.id, event.type, event.objectId)
        }))
    }

    // ---- Both

    /** Read the PaymentIntent from Stripe and bring the ledger in line. Null when it is not one of ours. */
    private sync(paymentIntentId: string): Promise<StripePaymentRecord | null> {
        return runAs(SYSTEM, async () => {
            const known = await this.db.findStripePayment(paymentIntentId)
            if (!known) return null   // another integration on the same Stripe account
            const intent = await this.gateway().retrieveIntent(paymentIntentId)
            const { status, problem } = ledgerStatusFor(intent, known.amountCents)
            if (problem) this.log.error("payment.cashapp.amount_mismatch", { paymentIntentId, leaseId: known.leaseId, problem })
            const applied = await this.db.applyStripeUpdate({
                paymentIntentId, status, stripeStatus: intent.status, amountReceivedCents: intent.amountReceivedCents,
                currency: intent.currency, cashtag: intent.cashtag, failureMessage: problem ?? intent.failureMessage,
                today: localDate(new Date(), this.timeZone),
            })
            if (!applied) return null
            if (applied.before !== applied.payment.status) {
                this.log.info("payment.cashapp.settled", {
                    paymentIntentId, leaseId: applied.payment.leaseId, amount: applied.payment.amountCents / 100, from: applied.before, to: applied.payment.status,
                })
            }
            return applied.payment
        })
    }

    /** Every succeeded refund on the PaymentIntent becomes a 'refund' row (once). */
    private async syncRefunds(paymentIntentId: string): Promise<void> {
        const refunds = await this.gateway().listRefunds(paymentIntentId)
        for (const refund of refunds.filter((r) => r.status === "succeeded")) {
            const added = await this.db.recordStripeRefund({ paymentIntentId, refundId: refund.id, amount: refund.amountCents / 100 })
            if (added) this.log.info("payment.cashapp.refunded", { paymentIntentId, refundId: refund.id, amount: refund.amountCents / 100 })
        }
    }
}
