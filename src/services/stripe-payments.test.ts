import { describe, expect, it } from "vitest"

import type { NewStripePayment, StripePaymentUpdate } from "../types/inputs"
import type { LeaseWithUnit, StripePaymentRecord } from "../types/records"
import type { LeaseStore, StripePaymentStore } from "../types/stores"
import type { StripeGateway, StripeIntent } from "./stripe"
import { ledgerStatusFor, StripePaymentService } from "./stripe-payments"

const intent = (over: Partial<StripeIntent> = {}): StripeIntent => ({
    id: "pi_1", status: "requires_payment_method", amountCents: 95000, amountReceivedCents: 0, currency: "usd",
    clientSecret: "pi_1_secret_x", cashtag: null, failureMessage: null, ...over,
})

describe("what a PaymentIntent means for the ledger", () => {
    it("completes only when exactly the amount asked for arrived, in dollars", () => {
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 95000 }), 95000)).toEqual({ status: "completed", problem: null })
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 1000 }), 95000).status).toBe("pending")
        expect(ledgerStatusFor(intent({ status: "succeeded", amountReceivedCents: 95000, currency: "eur" }), 95000).problem).toContain("eur")
    })

    it("fails on cancel, and stays pending while the tenant can still pay (declined, in Cash App, processing)", () => {
        expect(ledgerStatusFor(intent({ status: "canceled" }), 95000).status).toBe("failed")
        for (const status of ["requires_payment_method", "requires_action", "processing"]) {
            expect(ledgerStatusFor(intent({ status }), 95000).status).toBe("pending")
        }
    })
})

const LEASE = { id: 7, unitId: 3, unitNum: "101", propertyName: "Maple Court" } as LeaseWithUnit

function fakes() {
    const created: Array<Parameters<StripeGateway["createCashAppIntent"]>[0]> = []
    const saved: NewStripePayment[] = []
    const updates: StripePaymentUpdate[] = []
    const intents = new Map<string, StripeIntent>()
    let rows: StripePaymentRecord[] = []

    const stripe: StripeGateway = {
        publishableKey: "pk_test_x",
        async createCashAppIntent(input) {
            created.push(input)
            const made = intent({ id: `pi_${created.length}`, clientSecret: `pi_${created.length}_secret`, amountCents: input.amountCents })
            intents.set(made.id, made)
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
                status: "pending", amountCents: Math.round(input.amount * 100), feeCents: input.feeCents, stripeStatus: input.stripeStatus }
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
    return { stripe, db, created, saved, updates, intents }
}

describe("Cash App checkout", () => {
    it("asks Stripe for the rent plus the processing fee, in cents, and saves a pending payment under the tenant's own key", async () => {
        const f = fakes()
        const service = new StripePaymentService(f.db, f.stripe, "America/Denver")
        expect(service.cashAppFee).toEqual({ basisPoints: 290, fixedCents: 30 })
        const checkout = await service.startCashApp("tenant:5", { amount: 950, idempotencyKey: "checkout-0001" })

        // $950 rent: Stripe keeps 2.9% + 30¢ of $978.69, which leaves $950
        expect(checkout).toEqual({ paymentIntentId: "pi_1", clientSecret: "pi_1_secret", fee: 28.69, total: 978.69 })
        expect(f.created).toEqual([{
            amountCents: 97869, description: "Rent - Unit 101, Maple Court (incl. $28.69 processing fee)",
            metadata: { leaseId: "7", tenantId: "5", rentCents: "95000", feeCents: "2869" },
            idempotencyKey: "cashapp:tenant:5:checkout-0001:97869",
        }])
        expect(f.saved[0]).toMatchObject({ leaseId: 7, tenantId: 5, amount: 978.69, feeCents: 2869, paymentIntentId: "pi_1", method: "Cash App Pay", idempotencyKey: "tenant:5:checkout-0001" })
    })

    it("the same checkout again (a retry, a second click) reuses the PaymentIntent", async () => {
        const f = fakes()
        const service = new StripePaymentService(f.db, f.stripe, "America/Denver")
        await service.startCashApp("tenant:5", { amount: 950, idempotencyKey: "checkout-0001" })
        expect(await service.startCashApp("tenant:5", { amount: 950, idempotencyKey: "checkout-0001" }))
            .toEqual({ paymentIntentId: "pi_1", clientSecret: "pi_1_secret", fee: 28.69, total: 978.69 })
        expect(f.created).toHaveLength(1)
        await expect(service.startCashApp("tenant:5", { amount: 900, idempotencyKey: "checkout-0001" })).rejects.toMatchObject({ code: "CHECKOUT_AMOUNT_CHANGED" })
    })

    it("refresh reads Stripe and completes the payment once the money arrived", async () => {
        const f = fakes()
        const service = new StripePaymentService(f.db, f.stripe, "America/Denver")
        await service.startCashApp("tenant:5", { amount: 950, idempotencyKey: "checkout-0001" })

        expect(await service.refreshForTenant("pi_1")).toEqual({ status: "pending", confirmation: "pi_1" })
        f.intents.set("pi_1", intent({ id: "pi_1", status: "succeeded", amountReceivedCents: 97869, cashtag: "$lee" }))
        expect(await service.refreshForTenant("pi_1")).toEqual({ status: "completed", confirmation: "pi_1" })
        expect(f.updates.at(-1)).toMatchObject({ status: "completed", stripeStatus: "succeeded", amountReceivedCents: 97869, cashtag: "$lee" })
        await expect(service.refreshForTenant("pi_unknown")).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("answers STRIPE_NOT_CONFIGURED without Stripe keys", async () => {
        const service = new StripePaymentService(fakes().db, null, "America/Denver")
        expect(service.publishableKey).toBeNull()
        await expect(service.startCashApp("tenant:5", { amount: 950, idempotencyKey: "checkout-0001" })).rejects.toMatchObject({ code: "STRIPE_NOT_CONFIGURED" })
    })
})
