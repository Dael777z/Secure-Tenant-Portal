import { runAs, SYSTEM } from "../db/identity"
import { silentLogger, type LogService } from "../logging"
import { AppError } from "../types/errors"
import type { CardDetails } from "../types/inputs"
import type { PaymentState, StripePaymentRecord } from "../types/records"
import type { LeaseStore, StripePaymentStore } from "../types/stores"
import { tenantIdOf } from "../utils/user-id"
import { CARD_FEE, feeFor, type FeeRate } from "./fees"
import { localDate } from "./ledger"
import type { StripeGateway, StripeIntent } from "./stripe"

/**
 * Rent paid by debit/credit card, Apple Pay or Google Pay, through Stripe (010):
 *
 *   1. pay       the browser collects the card in Stripe's own form or wallet sheet and sends
 *                only a ConfirmationToken. The amount passes the same rules as every tenant
 *                payment (tenant-service.ts: at least the balance, at most a few months ahead,
 *                none while a Cash App / Zelle report waits). The card is charged rent plus the
 *                processing fee (fees.ts), and a 'pending' Payment is written on the lease.
 *   2. check     if the bank wants the cardholder to confirm (3-D Secure), Stripe.js shows it,
 *                then the page asks for a refresh
 *   3. settle    Stripe (read at once, by the page's refresh, or by the webhook) says how it went:
 *                succeeded → 'completed', on the ledger with the fee as its own charge
 *                (so the balance drops by exactly the rent); canceled → 'failed'
 *
 * Usually steps 1 and 3 happen in the one request. The ledger only trusts Stripe itself: every
 * status is read fresh from Stripe's API, never from the browser or the webhook body, and a
 * payment only completes when the amount received is exactly the amount asked for. Refunds
 * made in Stripe come back through the webhook as 'refund' rows.
 */

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

export interface CardCheckout {
    paymentIntentId: string
    clientSecret: string
    /** Where the payment stands on the ledger now: usually 'completed' straight away. */
    status: PaymentState
    /** The bank wants the cardholder to confirm (3-D Secure): Stripe.js shows it, then refresh. */
    requiresAction: boolean
    /** The processing fee added, and what the card was charged: rent + fee. */
    fee: number
    total: number
}

/**
 * The checks every tenant payment passes (TenantService.checkTenantPayment): the amount
 * is allowed, and no Cash App / Zelle report is waiting for the office.
 */
export interface TenantPaymentRules {
    checkTenantPayment(lease: { id: number; monthlyRent: number }, amount: number): Promise<void>
}

const BRANDS: Record<string, string> = {
    visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay",
}
const WALLETS: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay", samsung_pay: "Samsung Pay", link: "Link" }

/** "Visa •••• 4242", or "Apple Pay (Visa •••• 4242)": how the ledger names the payment. */
export function cardLabel(card: CardDetails): string {
    const brand = card.brand ? BRANDS[card.brand] ?? card.brand[0]!.toUpperCase() + card.brand.slice(1) : "Card"
    const number = card.last4 ? `${brand} •••• ${card.last4}` : brand
    const wallet = card.wallet ? WALLETS[card.wallet] ?? card.wallet : null
    return (wallet ? `${wallet} (${number})` : number).slice(0, 60)
}

export class StripePaymentService {
    constructor(
        private readonly db: StripePaymentStore & Pick<LeaseStore, "findCurrentLease">,
        private readonly stripe: StripeGateway | null,
        private readonly rules: TenantPaymentRules,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    get publishableKey(): string | null {
        return this.stripe?.publishableKey ?? null
    }

    /** The card / Apple Pay / Google Pay fee rate; null when there is none (fees.ts) or Stripe is off. */
    get cardFee(): FeeRate | null {
        return this.stripe ? CARD_FEE : null
    }

    private gateway(): StripeGateway {
        if (!this.stripe) throw new AppError("STRIPE_NOT_CONFIGURED")
        return this.stripe
    }

    // ---- The tenant

    /**
     * Pay `amount` toward the tenant's current lease by card, Apple Pay or Google Pay. The browser
     * collects the card in Stripe's own form or wallet sheet and sends only a ConfirmationToken;
     * this reads what card it is, adds the card fee if there is one (fees.ts), and charges it at once.
     *
     * A declined card answers CARD_DECLINED and saves nothing (no money moved), so the tenant just
     * tries again. When the bank wants a check (3-D Secure), the answer says requiresAction: the
     * browser shows it, then asks for a refresh. The same `idempotencyKey` never charges twice.
     */
    // logs payment.card.start.succeeded { userId, amount, leaseId, paymentIntentId, wallet, status } or .failed
    startCard(userId: string, input: { amount: number; idempotencyKey: string; confirmationTokenId: string }): Promise<CardCheckout> {
        const facts: { leaseId?: number; paymentIntentId?: string; fee?: number; wallet?: string | null; status?: PaymentState } = {}
        return this.log.flow("payment.card.start", { userId, amount: input.amount }, async () => {
            const stripe = this.gateway()
            const tID = tenantIdOf(userId)
            const lease = await this.db.findCurrentLease(tID, localDate(new Date(), this.timeZone))
            if (!lease) throw new AppError("NO_ACTIVE_LEASE")
            facts.leaseId = lease.id
            const amountCents = Math.round(input.amount * 100)
            const { feeCents, totalCents } = CARD_FEE ? feeFor(amountCents, CARD_FEE) : { feeCents: 0, totalCents: amountCents }
            facts.fee = feeCents / 100
            // Scoped to the tenant, so one tenant's key can never match another's payment.
            const key = `tenant:${tID}:${input.idempotencyKey}`

            const answer = async (payment: StripePaymentRecord | null, intent: StripeIntent): Promise<CardCheckout> => {
                facts.paymentIntentId = intent.id
                facts.status = payment?.status ?? "pending"
                return {
                    paymentIntentId: intent.id, clientSecret: intent.clientSecret!, status: facts.status,
                    requiresAction: intent.status === "requires_action", fee: feeCents / 100, total: totalCents / 100,
                }
            }

            // This checkout already charged (a double click, a retry): answer with that payment, charge nothing new.
            const earlier = await this.db.findStripeCheckout(lease.id, key)
            if (earlier) {
                if (earlier.amountCents !== totalCents) throw new AppError("CHECKOUT_AMOUNT_CHANGED")
                return answer(await this.sync(earlier.paymentIntentId), await stripe.retrieveIntent(earlier.paymentIntentId))
            }

            // The same rules as a bank payment or a Cash App / Zelle report, on the rent (the fee is on top).
            await this.rules.checkTenantPayment(lease, input.amount)

            const entered = await stripe.readConfirmationToken(input.confirmationTokenId)
            if (entered.type !== "card" || !entered.card) throw new AppError("VALIDATION_ERROR")   // only cards (and wallets) here
            facts.wallet = entered.card.wallet

            // Keyed on the token too: after a decline, the next card is a new token, so Stripe does not replay the decline.
            const intent = await stripe.createCardIntent({
                amountCents: totalCents,
                description: `Rent - Unit ${lease.unitNum}, ${lease.propertyName}${feeCents ? ` (incl. $${(feeCents / 100).toFixed(2)} processing fee)` : ""}`,
                metadata: { leaseId: String(lease.id), tenantId: String(tID), rentCents: String(amountCents), feeCents: String(feeCents) },
                idempotencyKey: `card:${key}:${totalCents}:${input.confirmationTokenId}`,
                confirmationTokenId: input.confirmationTokenId,
            })
            const card = intent.card ?? entered.card
            await this.db.createStripePayment({
                leaseId: lease.id, tenantId: tID, amount: totalCents / 100, feeCents, paymentIntentId: intent.id, methodType: "card",
                method: cardLabel(card), card, stripeStatus: intent.status, idempotencyKey: key,
            })
            // Usually already succeeded: settle it now rather than wait for the webhook.
            return answer(await this.sync(intent.id), intent)
        }, () => ({ ...facts }))
    }

    /**
     * The tenant's page is back from the bank's check (or a redirect): read the payment's state
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
            if (problem) this.log.error("payment.stripe.amount_mismatch", { paymentIntentId, leaseId: known.leaseId, problem })
            const applied = await this.db.applyStripeUpdate({
                paymentIntentId, status, stripeStatus: intent.status, amountReceivedCents: intent.amountReceivedCents,
                currency: intent.currency, failureMessage: problem ?? intent.failureMessage,
                today: localDate(new Date(), this.timeZone),
            })
            if (!applied) return null
            if (applied.before !== applied.payment.status) {
                this.log.info("payment.stripe.settled", {
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
            if (added) this.log.info("payment.stripe.refunded", { paymentIntentId, refundId: refund.id, amount: refund.amountCents / 100 })
        }
    }
}
