import { describe, expect, it } from "vitest"

import type { CardDetails, NewStripePayment, StripePaymentUpdate } from "../types/inputs"
import type { LeaseWithUnit, StripePaymentRecord } from "../types/records"
import type { LeaseStore, StripePaymentStore } from "../types/stores"
import type { StripeGateway, StripeIntent } from "./stripe"
import { AppError } from "../types/errors"
import { cardLabel, ledgerStatusFor, StripePaymentService, type TenantPaymentRules } from "./stripe-payments"

const intent = (over: Partial<StripeIntent> = {}): StripeIntent => ({
    id: "pi_1", status: "requires_payment_method", amountCents: 95000, amountReceivedCents: 0, currency: "usd",
    clientSecret: "pi_1_secret_x", failureMessage: null, card: null, ...over,
})

describe("what a PaymentIntent means for the ledger", () => {
    it("completes only when exactly the amount asked for arrived, in dollars", () => {
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 95000 }), 95000)).toEqual({ status: "completed", problem: null })
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 1000 }), 95000).status).toBe("pending")
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 95000, currency: "eur" }), 95000).problem).toContain("eur")
    })

    it("fails on cancel, and stays pending while the tenant can still pay (declined, bank check, processing)", () => {
        expect(ledgerStatusFor(intent({ status: "canceled" }), 95000).status).toBe("failed")
        for (const status of ["requires_payment_method", "requires_action", "processing"]) {
            expect(ledgerStatusFor(intent({ status }), 95000).status).toBe("pending")
        }
    })
})

const LEASE = { id: 7, unitId: 3, unitNum: "101", propertyName: "Maple Court", monthlyRent: 950 } as LeaseWithUnit

function fakes() {
    const saved: NewStripePayment[] = []
    const updates: StripePaymentUpdate[] = []
    const intents = new Map<string, StripeIntent>()
    let rows: StripePaymentRecord[] = []
    const VISA = { brand: "visa", last4: "4242", funding: "credit", wallet: null }
    const cardCalls: Array<Parameters<StripeGateway["createCardIntent"]>[0]> = []
    /** What the next card charge does: succeed, decline, or ask for the bank's check. */
    const card = { token: { type: "card", card: VISA as CardDetails | null }, outcome: "succeeded" as "succeeded" | "declined" | "requires_action" }
    /** The tenant payment rules (tenant-service.ts): every call, and what they answer. */
    const checked: Array<{ leaseId: number; amount: number }> = []
    const rules: TenantPaymentRules & { refuse: AppError | null } = {
        refuse: null,
        async checkTenantPayment(lease, amount) {
            checked.push({ leaseId: lease.id, amount })
            if (rules.refuse) throw rules.refuse
        },
    }

    const stripe: StripeGateway = {
        publishableKey: "pk_test_x",
        async readConfirmationToken() { return card.token },
        async createCardIntent(input) {
            cardCalls.push(input)
            if (card.outcome === "declined") throw new AppError("CARD_DECLINED", { message: "Your card was declined.", declineCode: "generic_decline" })
            const id = `pi_card${cardCalls.length}`
            const made = intent({
                id, clientSecret: `${id}_secret`, amountCents: input.amountCents, status: card.outcome,
                amountReceivedCents: card.outcome === "succeeded" ? input.amountCents : 0, card: card.token.card,
            })
            intents.set(id, made)
            return made
        },
        async retrieveIntent(id) { return intents.get(id)! },
        async listRefunds() { return [] },
        verifyWebhook() { throw new Error("not used") },
    }
    const db: StripePaymentStore & Pick<LeaseStore, "findCurrentLease"> = {
        async findCurrentLease() { return LEASE },
        async findStripeCheckout(leaseId, key) {
            const s = saved.find((x) => x.leaseId === leaseId && x.idempotencyKey === key)
            return s ? rows.find((r) => r.paymentIntentId === s.paymentIntentId)! : null
        },
        async findStripePayment(id) { return rows.find((r) => r.paymentIntentId === id) ?? null },
        async createStripePayment(input) {
            saved.push(input)
            const row: StripePaymentRecord = { payId: saved.length, leaseId: input.leaseId, tenantId: input.tenantId, paymentIntentId: input.paymentIntentId,
                status: "pending", amountCents: Math.round(input.amount * 100), feeCents: input.feeCents, stripeStatus: input.stripeStatus,
                methodType: input.methodType, method: input.method }
            rows.push(row)
            return row
        },
        async applyStripeUpdate(update) {
            updates.push(update)
            const row = rows.find((r) => r.paymentIntentId === update.paymentIntentId)
            if (!row) return null
            const before = row.status
            const status = before === "pending" ? update.status : before
            rows = rows.map((r) => (r === row ? { ...r, status, stripeStatus: update.stripeStatus } : r))
            return { before, payment: { ...row, status } }
        },
        async recordStripeRefund() { return false },
        async recordStripeEvent() { return true },
    }
    return { stripe, db, rules, checked, saved, updates, intents, card, cardCalls }
}

const service = (f: ReturnType<typeof fakes>, stripe: StripeGateway | null = f.stripe) => new StripePaymentService(f.db, stripe, f.rules, "America/Denver")

describe("card, Apple Pay and Google Pay checkout", () => {
    it("names the card the way the ledger shows it", () => {
        expect(cardLabel({ brand: "visa", last4: "4242", funding: "credit", wallet: null })).toBe("Visa •••• 4242")
        expect(cardLabel({ brand: "mastercard", last4: "4444", funding: "debit", wallet: "apple_pay" })).toBe("Apple Pay (Mastercard •••• 4444)")
        expect(cardLabel({ brand: "amex", last4: "0005", funding: "credit", wallet: "google_pay" })).toBe("Google Pay (Amex •••• 0005)")
        expect(cardLabel({ brand: null, last4: null, funding: null, wallet: null })).toBe("Card")
    })

    it("charges the rent plus the card fee, on debit cards too, and settles it at once", async () => {
        const f = fakes()
        const payments = service(f)
        expect(payments.cardFee).toEqual({ basisPoints: 290, fixedCents: 30 })
        f.card.token.card = { brand: "visa", last4: "4242", funding: "debit", wallet: "apple_pay" }

        // $950 rent → $978.69 charged: Stripe keeps 2.9% + 30¢ of that, leaving $950
        const paid = await payments.startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" })
        expect(paid).toEqual({ paymentIntentId: "pi_card1", clientSecret: "pi_card1_secret", status: "completed", requiresAction: false, fee: 28.69, total: 978.69 })
        expect(f.checked).toEqual([{ leaseId: 7, amount: 950 }])   // the rules see the rent, not the fee
        expect(f.cardCalls[0]).toMatchObject({
            amountCents: 97869, confirmationTokenId: "ctoken_abc", idempotencyKey: "card:tenant:5:checkout-0001:97869:ctoken_abc",
            description: "Rent - Unit 101, Maple Court (incl. $28.69 processing fee)", metadata: { rentCents: "95000", feeCents: "2869" },
        })
        expect(f.saved[0]).toMatchObject({ methodType: "card", method: "Apple Pay (Visa •••• 4242)", feeCents: 2869, amount: 978.69,
            card: { brand: "visa", last4: "4242", funding: "debit", wallet: "apple_pay" } })

        // a double click: the same checkout answers with that payment and charges nothing new
        expect((await payments.startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_other" })).status).toBe("completed")
        expect(f.cardCalls).toHaveLength(1)
        await expect(payments.startCard("tenant:5", { amount: 900, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_other" }))
            .rejects.toMatchObject({ code: "CHECKOUT_AMOUNT_CHANGED" })
    })

    it("follows the tenant payment rules: a refused amount charges nothing", async () => {
        const f = fakes()
        f.rules.refuse = new AppError("AMOUNT_BELOW_BALANCE", { balance: 950, minimum: 950 })
        await expect(service(f).startCard("tenant:5", { amount: 100, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" }))
            .rejects.toMatchObject({ code: "AMOUNT_BELOW_BALANCE" })
        expect(f.cardCalls).toHaveLength(0)
        expect(f.saved).toHaveLength(0)
    })

    it("a declined card answers CARD_DECLINED and saves nothing", async () => {
        const f = fakes()
        f.card.outcome = "declined"
        await expect(service(f).startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" }))
            .rejects.toMatchObject({ code: "CARD_DECLINED", details: { message: "Your card was declined." } })
        expect(f.saved).toHaveLength(0)
    })

    it("a bank check (3-D Secure) leaves it pending, with requiresAction, until the refresh after", async () => {
        const f = fakes()
        f.card.outcome = "requires_action"
        const payments = service(f)
        const started = await payments.startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" })
        expect(started).toMatchObject({ status: "pending", requiresAction: true })
        expect(await payments.refreshForTenant("pi_card1")).toEqual({ status: "pending", confirmation: "pi_card1" })
        f.intents.set("pi_card1", { ...f.intents.get("pi_card1")!, status: "succeeded", amountReceivedCents: 97869 })
        expect(await payments.refreshForTenant("pi_card1")).toEqual({ status: "completed", confirmation: "pi_card1" })
        expect(f.updates.at(-1)).toMatchObject({ status: "completed", stripeStatus: "succeeded", amountReceivedCents: 97869 })
        await expect(payments.refreshForTenant("pi_unknown")).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("refuses a token that is not a card", async () => {
        const f = fakes()
        f.card.token = { type: "us_bank_account", card: null }
        await expect(service(f).startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" }))
            .rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        expect(f.cardCalls).toHaveLength(0)
    })

    it("answers STRIPE_NOT_CONFIGURED without Stripe keys", async () => {
        const f = fakes()
        const payments = service(f, null)
        expect(payments.publishableKey).toBeNull()
        expect(payments.cardFee).toBeNull()
        await expect(payments.startCard("tenant:5", { amount: 950, idempotencyKey: "checkout-0001", confirmationTokenId: "ctoken_abc" }))
            .rejects.toMatchObject({ code: "STRIPE_NOT_CONFIGURED" })
    })
})
