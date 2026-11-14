import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { DEFAULT_BODY_LIMIT } from "../middleware/body"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * Body sizes. A big body is read into memory before the route runs, so only the two receipt
 * routes may take one, and only from a signed-in manager who has passed the rate limit.
 */
const config = loadConfig({ NODE_ENV: "test" })
const pdfBase64 = (bytes: number) => { const b = Buffer.alloc(bytes); b.write("%PDF-1.7"); return b.toString("base64") }
const filler = (bytes: number) => "x".repeat(bytes)

describe.skipIf(!hasDatabase)("request body limits", () => {
    let t: TestDatabase
    let container: Container
    let started: Awaited<ReturnType<typeof listen>>
    let admin: Client
    let anonymous: Client
    let leaseId: number

    beforeAll(async () => {
        t = await freshDatabase("it_body_limit")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        started = await listen(createApp(container))
        admin = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.admin)
        anonymous = new Client(started.host, config.webOrigin)
        leaseId = (await t.owner.query("SELECT LeaseID AS id FROM Lease LIMIT 1")).rows[0].id
    })
    afterAll(async () => {
        await started?.close()
        await container?.close()
        await t?.drop()
    })

    it("the default limit is small", () => {
        expect(DEFAULT_BODY_LIMIT).toBe("100kb")
    })

    it("an ordinary route answers 413 to a body over the default limit, signed in or not", async () => {
        const big = { text: filler(150_000) }
        for (const who of [anonymous, admin]) {
            const res = await who.post("/api/auth/login", big)
            expect(res.status).toBe(413)
            expect(res.body).toEqual({ error: "PAYLOAD_TOO_LARGE" })
        }
        expect((await admin.post("/api/manager/properties", { name: filler(150_000), address: "x" })).status).toBe(413)
        expect((await admin.put("/api/manager/maintenance/1", { status: "resolved", note: filler(150_000) })).status).toBe(413)
    })

    it("an ordinary body still works at a normal size", async () => {
        const res = await admin.post("/api/manager/properties", { name: "Small Plaza", address: filler(400) })
        expect(res.status).toBe(201)
    })

    it("the receipt routes refuse a big body from someone who is not signed in, without reading it", async () => {
        const big = { amount: 5, method: "Cash", receipt: { filename: "r.pdf", data: pdfBase64(3_000_000) } }
        const post = await anonymous.post(`/api/manager/leases/${leaseId}/payments`, big)
        expect(post.status).toBe(401)
        const put = await anonymous.put(`/api/manager/leases/${leaseId}/payments/1/receipt`, big.receipt)
        expect(put.status).toBe(401)
    })

    it("the receipt routes take a 3 MB receipt from a signed-in manager, and still stop at their own limit", async () => {
        const ok = await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 5, method: "Cash", receipt: { filename: "r.pdf", data: pdfBase64(3_000_000) } })
        expect(ok.status).toBe(201)
        const tooBig = await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 5, method: "Cash", receipt: { filename: "r.pdf", data: pdfBase64(6_000_000) } })
        expect(tooBig.status).toBe(413)
    })

    it("a tenant gets no large-body allowance on the receipt route either", async () => {
        const tenant = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.tenant)
        const res = await tenant.post(`/api/manager/leases/${leaseId}/payments`, { amount: 5, method: "Cash", receipt: { filename: "r.pdf", data: pdfBase64(3_000_000) } })
        expect(res.status).toBe(403)
    })
})
