import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { RECEIPT_MAX_BYTES } from "../routes/validate"
import { ACCOUNTS, Client, createTenant, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * Edge cases that need the whole stack: receipt uploads, amounts and dates sent over HTTP, oversized
 * bodies, and the rent-billing job against a real database.
 */
const config = loadConfig({ NODE_ENV: "test" })
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])
const pdf = (size: number) => { const b = Buffer.alloc(size); b.write("%PDF-1.7"); return b }

describe.skipIf(!hasDatabase)("edge cases over HTTP", () => {
    let t: TestDatabase
    let container: Container
    let close: () => Promise<void>
    let started: Awaited<ReturnType<typeof listen>>
    let admin: Client
    let tenant: Client
    let leaseId: number
    const count = async (table: string) => Number((await t.owner.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)

    beforeAll(async () => {
        t = await freshDatabase("it_edge_cases")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        started = await listen(createApp(container))
        close = started.close
        admin = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.admin)
        tenant = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.tenant)
        leaseId = (await t.owner.query("SELECT lt.LeaseID AS id FROM Tenants t JOIN Lease_Tenants lt ON lt.tID = t.tID WHERE t.Email = $1", [ACCOUNTS.tenant.email])).rows[0].id
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    describe("payment receipts", () => {
        let paymentId: number
        const url = () => `/api/manager/leases/${leaseId}/payments/${paymentId}/receipt`
        beforeAll(async () => {
            const paid = await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 100, method: "Check" })
            expect(paid.status).toBe(201)
            paymentId = (await t.owner.query("SELECT max(payID) AS id FROM Payment")).rows[0].id
        })

        it("stores a picture and serves it back as the same bytes, with safe headers", async () => {
            expect((await admin.put(url(), { filename: "scan.png", data: png.toString("base64") })).status).toBe(200)
            const res = await admin.get(url())
            expect(res.status).toBe(200)
            expect(res.headers.get("content-type")).toBe("image/png")
            expect(res.headers.get("content-disposition")).toBe('inline; filename="scan.png"')
            expect(res.headers.get("x-content-type-options")).toBe("nosniff")
            expect(res.headers.get("cache-control")).toBe("private, no-store")
            expect(res.bytes.equals(png)).toBe(true)
        })

        it("trusts the bytes, not the name: a program called .png is refused", async () => {
            const fake = Buffer.from("MZ\u0090\u0000 this is not a picture")
            const res = await admin.put(url(), { filename: "photo.png", data: fake.toString("base64") })
            expect(res.status).toBe(400)
            expect(res.body.error).toBe("RECEIPT_INVALID")
        })

        it("accepts 4 MB and refuses a byte more", async () => {
            expect((await admin.put(url(), { filename: "big.pdf", data: pdf(RECEIPT_MAX_BYTES).toString("base64") })).status).toBe(200)
            const over = await admin.put(url(), { filename: "bigger.pdf", data: pdf(RECEIPT_MAX_BYTES + 1).toString("base64") })
            expect(over.status).toBe(400)
            expect(over.body.error).toBe("RECEIPT_INVALID")
        })

        it("cannot smuggle a path or a header through the file name", async () => {
            await admin.put(url(), { filename: '../../x"\r\nSet-Cookie: a=b.pdf', data: pdf(64).toString("base64") })
            const res = await admin.get(url())
            expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="[A-Za-z0-9._ -]+"$/)
            expect(res.headers.get("set-cookie")).toBeNull()
        })

        it("a bad receipt on a new payment records nothing", async () => {
            const before = await count("Payment")
            const res = await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 50, method: "Cash", receipt: { filename: "x.png", data: Buffer.from("nope").toString("base64") } })
            expect(res.status).toBe(400)
            expect(await count("Payment")).toBe(before)
        })

        it("a receipt for a payment that does not exist is a 404", async () => {
            const res = await admin.put(`/api/manager/leases/${leaseId}/payments/999999/receipt`, { filename: "a.png", data: png.toString("base64") })
            expect(res.status).toBe(404)
        })
    })

    describe("amounts and dates sent over HTTP", () => {
        it("refuses an amount that is zero, negative, a string or beyond $100,000", async () => {
            for (const amount of [0, -20, "50", 100_000.01, null]) {
                expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "late_fee", amount, dueDate: "2026-11-01" })).status, String(amount)).toBe(400)
            }
        })

        it("accepts a $19.99 late fee", async () => {
            const res = await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "late_fee", amount: 19.99, dueDate: "2026-11-01" })
            expect(res.status).toBe(201)
        })
        it("lets a tenant pay a balance with cents such as $19.99", async () => {
            expect((await tenant.post("/api/tenant/payments", { amount: 19.99 })).status).toBe(201)
        })

        it("answers a date that does not exist (2026-02-30) with a 400", async () => {
            const res = await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "late_fee", amount: 25, dueDate: "2026-02-30" })
            expect(res.status).toBe(400)
        })
    })

    describe("checkout keys", () => {
        it("a repeated key is one payment; the same key from another tenant is a separate payment", async () => {
            const key = "checkout-key-shared-123"
            const mine = await tenant.post("/api/tenant/payments", { amount: 10, idempotencyKey: key })
            const again = await tenant.post("/api/tenant/payments", { amount: 10, idempotencyKey: key })
            expect(mine.status).toBe(201)
            expect(again.body.confirmation).toBe(mine.body.confirmation)

            const neighbour = await createTenant(admin, started.host, config.webOrigin)
            const theirs = await neighbour.post("/api/tenant/payments", { amount: 10, idempotencyKey: key })
            expect(theirs.status).toBe(201)
            expect(theirs.body.confirmation).not.toBe(mine.body.confirmation)
        })
    })

    describe("big requests", () => {
        it("answers a body over the 6 MB limit with 413", async () => {
            const res = await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "late_fee", amount: 25, dueDate: "2026-11-01", description: "x".repeat(7 * 1024 * 1024) })
            expect(res.status).toBe(413)
        })
        it("accepts a body a little under the limit (a maximum receipt is about 5.6 MB as text)", async () => {
            const res = await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 5, method: "Check", receipt: { filename: "max.pdf", data: pdf(RECEIPT_MAX_BYTES).toString("base64") } })
            expect(res.status).toBe(201)
        })
    })

    describe("rent billing job", () => {
        it("is safe to run again: the second run adds nothing", async () => {
            await container.rentCharges.run()
            const after = await count("Charge")
            expect(await container.rentCharges.run()).toBe(0)
            expect(await count("Charge")).toBe(after)
        })
    })
})
