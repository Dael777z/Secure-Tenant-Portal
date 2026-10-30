// Cash App Pay through Stripe (006): checkout → pending Payment → Stripe's signed webhook
// → completed, on the ledger; refunds; replays; another tenant. Stripe itself is a fake
// (no network), but webhook signatures are made and checked by Stripe's own library.
// Skipped without TEST_DATABASE_URL.
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import Stripe from "stripe"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { toWebhookEvent, type StripeGateway, type StripeIntent, type StripeRefundState } from "../services/stripe"
import { AppError } from "../types/errors"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const config = loadConfig({ NODE_ENV: "test" })
const WEBHOOK_SECRET = "whsec_test_portal"
const stripeLib = new Stripe("sk_test_not_used")

/** Stripe without the network: PaymentIntents and refunds live in maps the test changes. */
function fakeStripe() {
    const intents = new Map<string, StripeIntent>()
    const refunds = new Map<string, StripeRefundState[]>()
    let next = 0
    const gateway: StripeGateway = {
        publishableKey: "pk_test_portal",
        async createCashAppIntent(input) {
            const id = `pi_test${++next}`
            const made: StripeIntent = { id, status: "requires_payment_method", amountCents: input.amountCents, amountReceivedCents: 0,
                currency: "usd", clientSecret: `${id}_secret_abc`, cashtag: null, failureMessage: null }
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
    return { gateway, intents, refunds, settle }
}

describe.skipIf(!hasDatabase)("Cash App Pay through Stripe", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let base: string
    const stripe = fakeStripe()
    let eventCount = 0

    beforeAll(async () => {
        t = await freshDatabase("it_stripe")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null, stripe: stripe.gateway, email: null })
        server = createApp(container).listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    })
    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        await container?.close()
        await t?.drop()
    })

    async function signIn(email: string, password: string) {
        const cookies = new Map<string, string>()
        const call = async (method: string, path: string, body?: unknown) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: {
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                    ...(method === "GET" ? {} : { origin: config.webOrigin }),
                    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            for (const line of res.headers.getSetCookie()) {
                const [name, value] = line.split(";")[0]!.split("=")
                if (value) cookies.set(name!, value)
            }
            const text = await res.text()
            return { status: res.status, body: text ? JSON.parse(text) : {} }
        }
        const c = { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) }
        expect((await c.post("/auth/login", { email, password })).status).toBe(200)
        return c
    }

    /** Stripe calling the webhook: an event signed with the webhook secret (or `signature` to tamper). */
    async function webhook(type: string, object: Record<string, unknown>, signature?: string) {
        const payload = JSON.stringify({ id: `evt_test${++eventCount}`, object: "event", type, data: { object }, livemode: false, created: 0 })
        return send(payload, signature ?? stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }))
    }
    async function send(payload: string, signature: string | null) {
        const res = await fetch(`${base}/stripe/webhook`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) },
            body: payload,
        })
        return { status: res.status, body: await res.json() }
    }

    const feeCharges = async () => (await t.owner.query("SELECT amount FROM Charge WHERE kind = 'processing_fee' ORDER BY chargeID")).rows

    const paymentRow = async (pi: string) => (await t.owner.query(
        `SELECT p.status, p.amount, d.method, d.tID AS tid, s.stripe_status, s.amount_received_cents, s.cashtag
         FROM Payment p JOIN Payment_Details d ON d.payID = p.payID JOIN Stripe_Payments s ON s.payID = p.payID
         WHERE p.transaction_id = $1`, [pi])).rows[0]

    it("a checkout is pending (off the balance) until Stripe's webhook says the money arrived; then it is on the ledger", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const before = (await tenant.get("/tenant/summary")).body
        expect(before).toMatchObject({ cashAppEnabled: true, stripePublishableKey: "pk_test_portal", cashAppFee: { basisPoints: 290, fixedCents: 30 } })

        // $250 toward rent: Cash App charges $257.78 (2.9% + 30¢ of that is $7.78)
        const started = await tenant.post("/tenant/payments/cashapp", { amount: 250, idempotencyKey: "checkout-aaaa-0001" })
        expect(started.status).toBe(201)
        const pi = started.body.paymentIntentId as string
        expect(started.body).toMatchObject({ clientSecret: `${pi}_secret_abc`, fee: 7.78, total: 257.78 })
        expect(stripe.intents.get(pi)!.amountCents).toBe(25778)

        // The same checkout again: the same PaymentIntent, still one Payment row.
        expect((await tenant.post("/tenant/payments/cashapp", { amount: 250, idempotencyKey: "checkout-aaaa-0001" })).body.paymentIntentId).toBe(pi)
        expect((await t.owner.query("SELECT count(*)::int AS n FROM Payment WHERE transaction_id = $1", [pi])).rows[0].n).toBe(1)

        expect(await paymentRow(pi)).toMatchObject({ status: "pending", amount: 257.78, method: "Cash App Pay", stripe_status: "requires_payment_method" })
        expect((await tenant.get("/tenant/summary")).body.currentBalance).toBe(before.currentBalance)
        expect(await feeCharges()).toEqual([])   // no fee until the payment completes

        // Cash App approved it; Stripe tells us.
        stripe.settle(pi, { status: "succeeded", amountReceivedCents: 25778, cashtag: "$testtenant" })
        const hook = await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })
        expect(hook).toEqual({ status: 200, body: { received: true } })

        expect(await paymentRow(pi)).toMatchObject({ status: "completed", stripe_status: "succeeded", amount_received_cents: 25778, cashtag: "$testtenant" })
        const after = (await tenant.get("/tenant/summary")).body
        // The fee is its own charge and the payment is the whole amount: the balance drops by exactly the rent paid.
        expect(after.currentBalance).toBeCloseTo(before.currentBalance - 250, 2)
        expect(after.ledger[0]).toMatchObject({ description: "Payment received", amount: 257.78, method: "Cash App Pay", confirmation: pi })
        expect(after.ledger[1]).toMatchObject({ description: "Cash App Pay processing fee", amount: -7.78 })
        expect(await feeCharges()).toEqual([{ amount: 7.78 }])
        expect((await t.owner.query("SELECT type, object_id FROM Stripe_Events")).rows).toContainEqual({ type: "payment_intent.succeeded", object_id: pi })

        // Stripe sends events more than once: nothing changes the second time (one fee, one payment).
        expect((await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })).status).toBe(200)
        expect((await tenant.post(`/tenant/payments/cashapp/${pi}/refresh`)).body.status).toBe("completed")
        expect((await tenant.get("/tenant/summary")).body.currentBalance).toBeCloseTo(after.currentBalance, 2)
        expect(await feeCharges()).toHaveLength(1)

        // A refund made in Stripe's dashboard comes back as a refund row, once.
        stripe.refunds.set(pi, [{ id: "re_test1", amountCents: 10000, status: "succeeded" }, { id: "re_test2", amountCents: 5000, status: "pending" }])
        for (let i = 0; i < 2; i++) {
            expect((await webhook("charge.refunded", { id: "ch_test1", object: "charge", payment_intent: pi })).status).toBe(200)
        }
        const refunded = (await tenant.get("/tenant/summary")).body
        expect(refunded.currentBalance).toBeCloseTo(after.currentBalance + 100, 2)
        expect(refunded.ledger.filter((e: { confirmation?: string }) => e.confirmation === "re_test1")).toHaveLength(1)
        expect((await t.owner.query("SELECT count(*)::int AS n FROM Payment WHERE transaction_id = 're_test2'")).rows[0].n).toBe(0)

        // The database keeps a completed payment completed.
        await expect(t.owner.query("UPDATE Payment SET status = 'pending' WHERE transaction_id = $1", [pi])).rejects.toThrow("cannot become pending")
    })

    it("refresh settles without the webhook; a canceled checkout is failed and never touches the balance", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const before = (await tenant.get("/tenant/summary")).body.currentBalance
        const pi = (await tenant.post("/tenant/payments/cashapp", { amount: 40, idempotencyKey: "checkout-bbbb-0002" })).body.paymentIntentId as string

        expect((await tenant.post(`/tenant/payments/cashapp/${pi}/refresh`)).body).toEqual({ status: "pending", confirmation: pi })
        stripe.settle(pi, { status: "canceled" })
        expect((await tenant.post(`/tenant/payments/cashapp/${pi}/refresh`)).body).toEqual({ status: "failed", confirmation: pi })
        expect((await tenant.get("/tenant/summary")).body.currentBalance).toBe(before)   // and no fee for a canceled payment

        // Even if Stripe later said it succeeded, a failed payment stays failed (a person sorts that out).
        stripe.settle(pi, { status: "succeeded", amountReceivedCents: 4000 })
        await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })
        expect((await paymentRow(pi)).status).toBe("failed")
    })

    it("does not complete a payment when the amount received differs", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const pi = (await tenant.post("/tenant/payments/cashapp", { amount: 60, idempotencyKey: "checkout-cccc-0003" })).body.paymentIntentId as string
        stripe.settle(pi, { status: "succeeded", amountReceivedCents: 100 })
        await webhook("payment_intent.succeeded", { id: pi, object: "payment_intent" })
        const row = await paymentRow(pi)
        expect(row.status).toBe("pending")
        expect((await t.owner.query("SELECT failure_message FROM Stripe_Payments s JOIN Payment p ON p.payID = s.payID WHERE p.transaction_id = $1", [pi])).rows[0].failure_message)
            .toContain("expected 6211")   // $60 + its $2.11 fee
    })

    it("refuses unsigned or forged webhooks, and another tenant's payment", async () => {
        const forged = await webhook("payment_intent.succeeded", { id: "pi_test1", object: "payment_intent" }, "t=1,v1=deadbeef")
        expect(forged).toEqual({ status: 400, body: { error: "WEBHOOK_SIGNATURE_INVALID" } })
        expect((await send("{}", null)).status).toBe(400)

        const james = await signIn("james.johnson@example.com", PASSWORDS.tenant)
        expect((await james.post("/tenant/payments/cashapp/pi_test1/refresh")).status).toBe(404)
        expect((await james.post("/tenant/payments/cashapp", { amount: 10 })).status).toBe(400)   // a checkout key is required
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
