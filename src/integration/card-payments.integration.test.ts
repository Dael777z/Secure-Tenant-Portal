// Cards, Apple Pay and Google Pay through Stripe (010): card token → charge → pending Payment →
// settled (at once, by refresh, or by Stripe's signed webhook) → on the ledger with the fee as its
// own charge; the tenant payment rules; refunds; replays; another tenant. Stripe itself is a fake
// (no network), but webhook signatures are made and checked by Stripe's own library.
// Skipped without TEST_DATABASE_URL.
import Stripe from "stripe"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { CARD_FEE, feeFor } from "../services/fees"
import { toWebhookEvent, type StripeGateway, type StripeIntent, type StripeRefundState } from "../services/stripe"
import { AppError } from "../types/errors"
import type { CardDetails } from "../types/inputs"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"
import { ACCOUNTS, Client, listen } from "./http-client"

const config = loadConfig({ NODE_ENV: "test" })
const WEBHOOK_SECRET = "whsec_test_portal"
const stripeLib = new Stripe("sk_test_not_used")

/** Stripe without the network: PaymentIntents and refunds live in maps the test changes. */
function fakeStripe() {
    const intents = new Map<string, StripeIntent>()
    const refunds = new Map<string, StripeRefundState[]>()
    /** ConfirmationTokens "made in the browser": the card each one carries. */
    const tokens = new Map<string, CardDetails>()
    let next = 0
    const gateway: StripeGateway = {
        publishableKey: "pk_test_portal",
        async readConfirmationToken(id) { return { type: "card", card: tokens.get(id) ?? null } },
        async createCardIntent(input) {
            const card = tokens.get(input.confirmationTokenId) ?? null
            if (card?.last4 === "0002") throw new AppError("CARD_DECLINED", { message: "Your card was declined.", declineCode: "generic_decline" })
            const id = `pi_test${++next}`
            const needsCheck = card?.last4 === "3184"   // Stripe's 3-D Secure test card
            const made: StripeIntent = { id, status: needsCheck ? "requires_action" : "succeeded", amountCents: input.amountCents,
                amountReceivedCents: needsCheck ? 0 : input.amountCents, currency: "usd", clientSecret: `${id}_secret_abc`, failureMessage: null, card }
            intents.set(id, made)
            return made
        },
        async retrieveIntent(id) { return intents.get(id)! },
        async listRefunds(id) { return refunds.get(id) ?? [] },
        verifyWebhook(rawBody, signature) {
            try {
                return toWebhookEvent(stripeLib.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET))
            } catch {
                throw new AppError("WEBHOOK_SIGNATURE_INVALID")
            }
        },
    }
    const settle = (id: string, over: Partial<StripeIntent>) => intents.set(id, { ...intents.get(id)!, ...over })
    return { gateway, intents, refunds, tokens, settle }
}

/** What a card is charged for `amount` of rent. */
const charged = (amount: number) => {
    const { feeCents, totalCents } = feeFor(Math.round(amount * 100), CARD_FEE!)
    return { fee: feeCents / 100, total: totalCents / 100, totalCents }
}

describe.skipIf(!hasDatabase)("cards, Apple Pay and Google Pay through Stripe", () => {
    let t: TestDatabase
    let container: Container
    let app: Awaited<ReturnType<typeof listen>>
    const stripe = fakeStripe()
    let eventCount = 0

    beforeAll(async () => {
        t = await freshDatabase("it_card_payments")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null, stripe: stripe.gateway })
        app = await listen(createApp(container))
        stripe.tokens.set("ctoken_applepay", { brand: "visa", last4: "4242", funding: "debit", wallet: "apple_pay" })
        stripe.tokens.set("ctoken_visa", { brand: "visa", last4: "4242", funding: "credit", wallet: null })
        stripe.tokens.set("ctoken_declined", { brand: "visa", last4: "0002", funding: "credit", wallet: null })
        stripe.tokens.set("ctoken_3ds", { brand: "mastercard", last4: "3184", funding: "credit", wallet: null })
    })
    afterAll(async () => {
        await app?.close()
        await container?.close()
        await t?.drop()
    })

    const signIn = (who: { email: string; password: string }) => new Client(app.host, config.webOrigin).signIn(who)
    const tenant = () => signIn(ACCOUNTS.tenant)

    /** Stripe calling the webhook: an event signed with the webhook secret (or `signature` to tamper). */
    async function webhook(type: string, object: Record<string, unknown>, signature?: string) {
        const payload = JSON.stringify({ id: `evt_test${++eventCount}`, object: "event", type, data: { object }, livemode: false, created: 0 })
        return send(payload, signature ?? stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }))
    }
    async function send(payload: string, signature: string | null) {
        const res = await new Client(app.host, config.webOrigin).call("POST", "/api/stripe/webhook", {
            body: payload, headers: signature ? { "stripe-signature": signature } : {},
        })
        return { status: res.status, body: res.body }
    }

    const feeCharges = async () => (await t.owner.query("SELECT amount FROM Charge WHERE kind = 'processing_fee' ORDER BY chargeID")).rows
    const paymentCount = async () => (await t.owner.query("SELECT count(*)::int AS n FROM Payment")).rows[0].n as number
    const paymentRow = async (pi: string) => (await t.owner.query(
        `SELECT p.status, p.amount, d.method, d.tID AS tid, s.stripe_status, s.amount_received_cents, s.failure_message
         FROM Payment p JOIN Payment_Details d ON d.payID = p.payID JOIN Stripe_Payments s ON s.payID = p.payID
         WHERE p.transaction_id = $1`, [pi])).rows[0]
    /** The smallest payment the tenant may make right now (the balance, or $1 when nothing is due). */
    const minimum = async (c: Client) => (await c.get("/api/tenant/summary")).body.payLimits.minimum as number

    it("charges the card at once with the fee on top; the balance drops by exactly the rent, and the fee is on the ledger", async () => {
        const c = await tenant()
        const before = (await c.get("/api/tenant/summary")).body
        expect(before).toMatchObject({ cardsEnabled: true, stripePublishableKey: "pk_test_portal", cardFee: { basisPoints: 290, fixedCents: 30 } })
        const amount = before.payLimits.minimum as number
        const { fee, total, totalCents } = charged(amount)

        const paid = await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0001", confirmationTokenId: "ctoken_applepay" })
        expect(paid.status).toBe(201)
        const pi = paid.body.paymentIntentId as string
        expect(paid.body).toMatchObject({ status: "completed", requiresAction: false, fee, total })
        expect(stripe.intents.get(pi)!.amountCents).toBe(totalCents)

        const after = (await c.get("/api/tenant/summary")).body
        expect(after.currentBalance).toBeCloseTo(before.currentBalance - amount, 2)
        expect(after.ledger).toContainEqual(expect.objectContaining({ amount: total, method: "Apple Pay (Visa •••• 4242)", confirmation: pi }))
        expect(after.ledger).toContainEqual(expect.objectContaining({ description: "Card processing fee", amount: -fee }))
        expect(await feeCharges()).toEqual([{ amount: fee }])
        expect((await t.owner.query(
            "SELECT method_type, card_brand, card_last4, card_funding, wallet FROM Stripe_Payments s JOIN Payment p ON p.payID = s.payID WHERE p.transaction_id = $1",
            [pi])).rows[0]).toEqual({ method_type: "card", card_brand: "visa", card_last4: "4242", card_funding: "debit", wallet: "apple_pay" })
        // 009's trigger tells the resident the payment arrived, like any other completed payment.
        expect((await t.owner.query(
            "SELECT count(*)::int AS n FROM Notifications_Sent n JOIN Payment p ON p.payID = n.source_payment WHERE p.transaction_id = $1 AND n.template = 'payment_received'",
            [pi])).rows[0].n).toBe(1)

        // A double click on Pay: the same checkout, nothing charged twice.
        const again = await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0001", confirmationTokenId: "ctoken_applepay" })
        expect(again.body.paymentIntentId).toBe(pi)
        expect((await c.get("/api/tenant/summary")).body.currentBalance).toBeCloseTo(after.currentBalance, 2)
        expect(await feeCharges()).toHaveLength(1)

        // The database keeps a completed payment completed.
        await expect(t.owner.query("UPDATE Payment SET status = 'pending' WHERE transaction_id = $1", [pi])).rejects.toThrow("cannot become pending")
    })

    it("follows the tenant payment rules: the most ahead, and one payment at a time while a report waits", async () => {
        const count = await paymentCount()
        const intents = stripe.intents.size

        const c = await tenant()
        const { maximum } = (await c.get("/api/tenant/summary")).body.payLimits
        const tooMuch = await c.post("/api/tenant/payments/card", { amount: maximum + 1, idempotencyKey: "checkout-card-0009", confirmationTokenId: "ctoken_visa" })
        expect(tooMuch).toMatchObject({ status: 409, body: { error: "AMOUNT_ABOVE_LIMIT" } })

        // James owes two months: less than the balance is refused (no partial payments).
        const james = await signIn({ email: "james.johnson@example.com", password: PASSWORDS.tenant })
        const owed = (await james.get("/api/tenant/summary")).body.currentBalance as number
        expect(owed).toBeGreaterThan(1)
        const partial = await james.post("/api/tenant/payments/card", { amount: 1, idempotencyKey: "checkout-card-0010", confirmationTokenId: "ctoken_visa" })
        expect(partial).toMatchObject({ status: 409, body: { error: "AMOUNT_BELOW_BALANCE" } })

        // Lucia's Zelle report is waiting for the office: no card payment until it is decided.
        const lucia = await signIn({ email: "lucia.reyes@example.com", password: PASSWORDS.tenant })
        const due = await minimum(lucia)
        const waiting = await lucia.post("/api/tenant/payments/card", { amount: due, idempotencyKey: "checkout-card-0011", confirmationTokenId: "ctoken_visa" })
        expect(waiting).toMatchObject({ status: 409, body: { error: "ALREADY_REPORTED" } })

        expect(await paymentCount()).toBe(count)
        expect(stripe.intents.size).toBe(intents)   // nothing reached Stripe
    })

    it("a declined card says why and records nothing; a bank check settles through Stripe's webhook", async () => {
        const c = await tenant()
        const count = await paymentCount()
        const amount = await minimum(c)

        const declined = await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0002", confirmationTokenId: "ctoken_declined" })
        expect(declined).toMatchObject({ status: 402, body: { error: "CARD_DECLINED", details: { message: "Your card was declined.", declineCode: "generic_decline" } } })
        expect(await paymentCount()).toBe(count)

        // The same checkout with another card works: the decline left nothing behind.
        const before = (await c.get("/api/tenant/summary")).body.currentBalance as number
        const checked = await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0002", confirmationTokenId: "ctoken_3ds" })
        expect(checked.body).toMatchObject({ status: "pending", requiresAction: true })
        const pi = checked.body.paymentIntentId as string
        expect(await paymentRow(pi)).toMatchObject({ status: "pending", method: "Mastercard •••• 3184", stripe_status: "requires_action" })
        expect((await c.get("/api/tenant/summary")).body.currentBalance).toBe(before)   // pending: off the balance

        // The tenant passed the bank's check; Stripe tells us.
        stripe.settle(pi, { status: "succeeded", amountReceivedCents: charged(amount).totalCents })
        expect(await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })).toEqual({ status: 200, body: { received: true } })
        expect(await paymentRow(pi)).toMatchObject({ status: "completed", stripe_status: "succeeded" })
        expect((await t.owner.query("SELECT type, object_id FROM Stripe_Events")).rows).toContainEqual({ type: "payment_intent.succeeded", object_id: pi })
        const after = (await c.get("/api/tenant/summary")).body.currentBalance as number
        expect(after).toBeCloseTo(before - amount, 2)

        // Stripe sends events more than once: nothing changes the second time (one fee, one payment).
        const fees = (await feeCharges()).length
        expect((await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })).status).toBe(200)
        expect((await c.post(`/api/tenant/payments/stripe/${pi}/refresh`)).body).toEqual({ status: "completed", confirmation: pi })
        expect((await c.get("/api/tenant/summary")).body.currentBalance).toBeCloseTo(after, 2)
        expect(await feeCharges()).toHaveLength(fees)

        // A refund made in Stripe's dashboard comes back as a refund row, once (pending refunds wait).
        stripe.refunds.set(pi, [{ id: "re_test1", amountCents: 100, status: "succeeded" }, { id: "re_test2", amountCents: 50, status: "pending" }])
        for (let i = 0; i < 2; i++) {
            expect((await webhook("charge.refunded", { id: "ch_test1", object: "charge", payment_intent: pi })).status).toBe(200)
        }
        const refunded = (await c.get("/api/tenant/summary")).body
        expect(refunded.currentBalance).toBeCloseTo(after + 1, 2)
        expect(refunded.ledger.filter((e: { confirmation?: string }) => e.confirmation === "re_test1")).toHaveLength(1)
        expect((await t.owner.query("SELECT count(*)::int AS n FROM Payment WHERE transaction_id = 're_test2'")).rows[0].n).toBe(0)
    })

    it("a canceled payment is failed and stays failed; an amount that differs is left for a person", async () => {
        const c = await tenant()
        const before = (await c.get("/api/tenant/summary")).body.currentBalance as number
        const amount = await minimum(c)

        const canceled = (await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0003", confirmationTokenId: "ctoken_3ds" })).body.paymentIntentId as string
        stripe.settle(canceled, { status: "canceled" })
        expect((await c.post(`/api/tenant/payments/stripe/${canceled}/refresh`)).body).toEqual({ status: "failed", confirmation: canceled })
        // Even if Stripe later said it succeeded, a failed payment stays failed (a person sorts that out).
        stripe.settle(canceled, { status: "succeeded", amountReceivedCents: charged(amount).totalCents })
        await webhook("payment_intent.succeeded", { id: canceled, object: "payment_intent" })
        expect((await paymentRow(canceled)).status).toBe("failed")

        const odd = (await c.post("/api/tenant/payments/card", { amount, idempotencyKey: "checkout-card-0004", confirmationTokenId: "ctoken_3ds" })).body.paymentIntentId as string
        stripe.settle(odd, { status: "succeeded", amountReceivedCents: 100 })
        await webhook("payment_intent.succeeded", { id: odd, object: "payment_intent" })
        const row = await paymentRow(odd)
        expect(row.status).toBe("pending")
        expect(row.failure_message).toContain(`expected ${charged(amount).totalCents}`)

        expect((await c.get("/api/tenant/summary")).body.currentBalance).toBe(before)   // neither touched the balance
    })

    it("refuses unsigned or forged webhooks, another tenant's payment, and malformed checkouts", async () => {
        const forged = await webhook("payment_intent.succeeded", { id: "pi_test1", object: "payment_intent" }, "t=1,v1=deadbeef")
        expect(forged).toEqual({ status: 400, body: { error: "WEBHOOK_SIGNATURE_INVALID" } })
        expect((await send("{}", null)).status).toBe(400)

        const james = await signIn({ email: "james.johnson@example.com", password: PASSWORDS.tenant })
        expect((await james.post("/api/tenant/payments/stripe/pi_test1/refresh")).status).toBe(404)
        expect((await james.post("/api/tenant/payments/stripe/not-a-pi/refresh")).status).toBe(400)
        expect((await james.post("/api/tenant/payments/card", { amount: 10, confirmationTokenId: "ctoken_visa" })).status).toBe(400)   // a checkout key is required
        expect((await james.post("/api/tenant/payments/card", { amount: 10, idempotencyKey: "checkout-card-0005", confirmationTokenId: "not-a-token" })).status).toBe(400)

        // Staff do not pay rent.
        const office = await signIn(ACCOUNTS.admin)
        expect((await office.post("/api/tenant/payments/card", { amount: 10, idempotencyKey: "checkout-card-0006", confirmationTokenId: "ctoken_visa" })).status).toBe(403)
    })

    it("tenants can read their own Stripe rows; the app's login cannot write them as a tenant", async () => {
        const tid = (await t.owner.query("SELECT tID FROM Tenants WHERE Email = 'tenant@example.com'")).rows[0].tid as number
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'tenant', true), set_config('app.user_id', $1, true)", [String(tid)])
            expect((await client.query("SELECT count(*)::int AS n FROM Stripe_Payments")).rows[0].n).toBeGreaterThan(0)
            expect((await client.query("SELECT count(*)::int AS n FROM Stripe_Events")).rows[0].n).toBe(0)
            await expect(client.query("UPDATE Stripe_Payments SET stripe_status = 'succeeded'")).resolves.toMatchObject({ rowCount: 0 })
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    })
})
