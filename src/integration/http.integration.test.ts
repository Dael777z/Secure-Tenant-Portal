import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { AppError } from "../types/errors"
import { createApp } from "../create-app"
import { createContainer, type Container } from "../container"
import { createLogger } from "../logging"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * The whole stack over HTTP: createApp(createContainer(...)) on a freshly
 * seeded test database, driven with fetch like the browser does.
 */
const ADMIN = { email: "manager@example.com", password: PASSWORDS.staff }
const TENANT = { email: "tenant@example.com", password: PASSWORDS.tenant }
const MAINTENANCE = { email: "maintenance@example.com", password: PASSWORDS.staff }
const config = loadConfig({ NODE_ENV: "test" })
const ORIGIN = config.webOrigin

/** A tiny browser: keeps cookies between calls. */
class Client {
    private cookies = new Map<string, string>()
    constructor(private readonly base: string) {}

    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const res = await fetch(`${this.base}${path}`, {
            method,
            headers: {
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...(method === "GET" ? {} : { origin: ORIGIN }),
                cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(";")
            const [name, value] = pair!.split("=")
            if (value) this.cookies.set(name!, value)
            else this.cookies.delete(name!)
        }
        const text = await res.text()
        return { status: res.status, body: text ? JSON.parse(text) : {} }
    }
    get = (path: string) => this.call("GET", path)
    post = (path: string, body?: unknown, headers?: Record<string, string>) => this.call("POST", path, body ?? {}, headers)
    put = (path: string, body?: unknown) => this.call("PUT", path, body ?? {})
    delete = (path: string) => this.call("DELETE", path)
}

describe.skipIf(!hasDatabase)("HTTP API on a seeded database", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let base: string
    /** Every line the app logs, at info and up (tests normally log warnings only). */
    const logged: Array<{ event: string; request_id?: string; metadata?: Record<string, unknown> }> = []
    const logger = createLogger({ ...config, mode: "development" }, { write: (line: string) => { logged.push(JSON.parse(line)) } })

    beforeAll(async () => {
        t = await freshDatabase("portal_http_test")
        await seed(t.owner, { dataset: "clean", webOrigin: ORIGIN, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null, logger })
        server = createApp(container).listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    })
    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        await container?.close()
        await t?.drop()
    })

    const anonymous = () => new Client(base)
    const signedIn = async (who: { email: string; password: string }) => {
        const client = anonymous()
        expect((await client.post("/auth/login", who)).status).toBe(200)
        return client
    }

    it("rejects the wrong password and unauthenticated calls", async () => {
        const bad = await anonymous().post("/auth/login", { email: ADMIN.email, password: "nope" })
        expect(bad.status).toBe(401)
        expect((await anonymous().get("/manager/dashboard")).status).toBe(401)
        expect((await anonymous().get("/tenant/summary")).status).toBe(401)
    })

    it("signs in, reports who it is, and rotates the session", async () => {
        const agent = await signedIn(ADMIN)
        const me = await agent.get("/auth/me")
        expect(me.body.user.role).toBe("admin")
        expect(me.body.user.permissions).toContain("users:provision")
        expect((await agent.post("/auth/refresh")).status).toBe(200)
        expect((await agent.get("/auth/me")).status).toBe(200)
        expect((await agent.post("/auth/logout")).status).toBe(204)
    })

    it("keeps tenants out of the manager routes and staff out of the tenant routes", async () => {
        const tenant = await signedIn(TENANT)
        expect((await tenant.get("/manager/tenants")).status).toBe(403)
        const admin = await signedIn(ADMIN)
        expect((await admin.get("/tenant/summary")).status).toBe(403)
    })

    it("lets maintenance staff work the queue and nothing else", async () => {
        const staff = await signedIn(MAINTENANCE)
        const me = await staff.get("/auth/me")
        expect(me.body.user).toMatchObject({ role: "maintenance_staff", permissions: ["maintenance:manage"] })
        expect((await staff.get("/manager/me")).body).toMatchObject({ role: "maintenance_staff" })

        const queue = await staff.get("/manager/maintenance")
        expect(queue.status).toBe(200)
        const filed = await staff.post("/manager/maintenance", { unitId: queue.body.units[0].id, title: "Gate sticks" })
        expect(filed.status).toBe(201)
        expect((await staff.put(`/manager/maintenance/${filed.body.id}`, { status: "in_progress" })).status).toBe(200)

        expect((await staff.get("/manager/dashboard")).status).toBe(403)
        expect((await staff.get("/manager/tenants")).status).toBe(403)
        expect((await staff.post("/manager/leases/1/payments", { amount: 5, method: "Cash" })).status).toBe(403)
        // A session refresh keeps the narrower role.
        expect((await staff.post("/auth/refresh")).status).toBe(200)
        expect((await staff.get("/auth/me")).body.user.role).toBe("maintenance_staff")
    })

    it("adds a late fee to a lease, and refuses rent or a bad kind", async () => {
        const admin = await signedIn(ADMIN)
        const lease = (await admin.get("/manager/tenants")).body.tenants?.find?.((x: { leaseId: number | null }) => x.leaseId)?.leaseId ?? 1
        const added = await admin.post(`/manager/leases/${lease}/charges`, { kind: "late_fee", amount: 25, dueDate: "2026-10-16", description: "Late fee" })
        expect(added.status).toBe(201)
        expect(JSON.stringify((await admin.get(`/manager/leases/${lease}`)).body)).toContain("Late fee")
        expect((await admin.post(`/manager/leases/${lease}/charges`, { kind: "rent", amount: 25, dueDate: "2026-10-16" })).status).toBe(400)
        expect((await admin.post(`/manager/leases/${lease}/charges`, { kind: "late_fee", amount: -1, dueDate: "2026-10-16" })).status).toBe(400)
    })

    /** The test tenant's balance, after the office bills `extra` (a utility charge) when it is zero. */
    const owing = async (tenant: Client, extra = 40) => {
        let balance = (await tenant.get("/tenant/summary")).body.currentBalance as number
        if (balance <= 0) {
            // Nothing owed (or credit from paying ahead): add a charge bigger than the credit.
            const admin = await signedIn(ADMIN)
            const row = (await admin.get("/manager/tenants")).body.tenants.find((x: { email: string }) => x.email === TENANT.email)
            const amount = Math.round((extra - balance) * 100) / 100
            expect((await admin.post(`/manager/leases/${row.leaseId}/charges`, { kind: "utility", amount, dueDate: "2026-10-01", description: "Water" })).status).toBe(201)
            balance = (await tenant.get("/tenant/summary")).body.currentBalance
        }
        return balance
    }

    it("records a tenant checkout once, however many times it is sent", async () => {
        const tenant = await signedIn(TENANT)
        const amount = await owing(tenant)
        const first = await tenant.post("/tenant/payments", { amount, idempotencyKey: "checkout-1234-abcd" })
        const again = await tenant.post("/tenant/payments", { amount, idempotencyKey: "checkout-1234-abcd" })
        expect(first.status).toBe(201)
        expect(again.status).toBe(201)
        expect(again.body.confirmation).toBe(first.body.confirmation)
        expect((await tenant.post("/tenant/payments", { amount, idempotencyKey: "no spaces allowed" })).status).toBe(400)
    })

    it("a tenant pays at least the balance, and may pay up to 3 months of rent ahead as credit", async () => {
        const tenant = await signedIn(TENANT)
        const amount = await owing(tenant)
        const limits = (await tenant.get("/tenant/summary")).body.payLimits
        expect(limits).toMatchObject({ minimum: amount, credit: 0, prepayMonths: 3, canPay: true })
        expect(limits.maximum).toBeCloseTo(amount + 3 * limits.monthlyRent, 2)
        const rent = limits.monthlyRent as number

        // Part of the balance: refused. More than the limit: refused.
        expect(await tenant.post("/tenant/payments", { amount: Math.round((amount - 1) * 100) / 100 })).toMatchObject({ status: 409, body: { error: "AMOUNT_BELOW_BALANCE" } })
        expect(await tenant.post("/tenant/payments", { amount: Math.round((limits.maximum + 0.01) * 100) / 100 })).toMatchObject({ status: 409, body: { error: "AMOUNT_ABOVE_LIMIT" } })

        // The balance plus $100 ahead: the $100 is credit.
        expect((await tenant.post("/tenant/payments", { amount: Math.round((amount + 100) * 100) / 100, idempotencyKey: "prepay-1" })).status).toBe(201)
        const after = (await tenant.get("/tenant/summary")).body
        expect(after.currentBalance).toBeCloseTo(-100, 2)
        expect(after.payLimits).toMatchObject({ minimum: 1, credit: 100, canPay: true })
        expect(after.payLimits.maximum).toBeCloseTo(3 * rent - 100, 2)
        expect(after.notices.find((n: { id: string }) => n.id === "n_credit")?.title).toBe("$100.00 credit on your account")

        // The office sees the same credit (one ledger, two sides).
        const admin = await signedIn(ADMIN)
        const row = (await admin.get("/manager/tenants")).body.tenants.find((x: { email: string }) => x.email === TENANT.email)
        expect((await admin.get(`/manager/leases/${row.leaseId}`)).body.balance).toBeCloseTo(-100, 2)

        // With nothing due: at least $1, and up to the rest of the limit.
        expect((await tenant.post("/tenant/payments", { amount: 0.5 })).status).toBe(400)
        expect((await tenant.post("/tenant/payments", { amount: after.payLimits.maximum, idempotencyKey: "prepay-2" })).status).toBe(201)
        const full = (await tenant.get("/tenant/summary")).body
        expect(full.currentBalance).toBeCloseTo(-3 * rent, 2)
        expect(full.payLimits).toMatchObject({ maximum: 0, canPay: false })
        expect(await tenant.post("/tenant/payments", { amount: 1 })).toMatchObject({ status: 409, body: { error: "AMOUNT_ABOVE_LIMIT" } })
    })

    it("shows a tenant their own summary, and lets them pay and file a request", async () => {
        const tenant = await signedIn(TENANT)
        const before = await tenant.get("/tenant/summary")
        expect(before.status).toBe(200)

        expect(before.body).toMatchObject({ plaidEnabled: false, testPayments: true })
        const pay = await tenant.post("/tenant/payments", { amount: await owing(tenant) })   // development: a test transfer
        expect(pay.status).toBe(201)
        expect(pay.body.confirmation).toMatch(/^CONF-/)

        const bad = await tenant.post("/tenant/payments", { amount: -5 })
        expect(bad.status).toBe(400)

        const req = await tenant.post("/tenant/maintenance", { title: "Leaky tap" })
        expect(req.status).toBe(201)
        const after = await tenant.get("/tenant/summary")
        expect(JSON.stringify(after.body)).toContain("Leaky tap")
    })

    it("the office invites a tenant, who signs up from the link, then leases and pays", async () => {
        const admin = await signedIn(ADMIN)

        const prop = await admin.post("/manager/properties", { name: "HTTP Court", address: "1 Test St" })
        expect(prop.status).toBe(201)
        const unit = await admin.post("/manager/units", { propertyId: prop.body.id, unitNum: "Z1" })
        expect(unit.status).toBe(201)

        const lease = await admin.post("/manager/leases", {
            unitId: unit.body.id,
            startDate: "2026-09-01",
            monthlyRent: 800,
            newTenants: [{ name: "New Person", email: "new.person@example.com" }],
        })
        expect(lease.status).toBe(201)
        const [invite] = lease.body.invites
        expect(invite.inviteLink).toContain("/signup?token=")

        // Not signed up yet: cannot sign in.
        const early = await anonymous().post("/auth/login", { email: "new.person@example.com", password: "whatever-123" })
        expect(early.status).toBe(401)

        const signup = await anonymous().post("/auth/signup", { token: invite.inviteToken, password: "new-person-pw-1" })
        expect(signup.status).toBe(201)
        expect(signup.body.role).toBe("tenant")
        // The link works once.
        const again = await anonymous().post("/auth/signup", { token: invite.inviteToken, password: "another-pw-12" })
        expect(again.status).toBeGreaterThanOrEqual(400)

        const newTenant = await signedIn({ email: "new.person@example.com", password: "new-person-pw-1" })
        expect((await newTenant.get("/tenant/summary")).status).toBe(200)

        // The office records a check.
        const paid = await admin.post(`/manager/leases/${lease.body.id}/payments`, { amount: 300, method: "Check" })
        expect(paid.status).toBe(201)
        expect(paid.body.confirmation).toMatch(/^OFF-/)
        const detail = await admin.get(`/manager/leases/${lease.body.id}`)
        expect(detail.status).toBe(200)

        // Overlapping lease on the same unit is a 409.
        const clash = await admin.post("/manager/leases", {
            unitId: unit.body.id, startDate: "2026-10-01", monthlyRent: 800, newTenants: [{ name: "Other", email: "other@example.com" }],
        })
        expect(clash.status).toBe(409)
        expect(clash.body.error).toBe("UNIT_OCCUPIED")

        // Leases are not deleted.
        const del = await admin.delete(`/manager/leases/${lease.body.id}`)
        expect(del.status).toBe(404)

        // Each step is in the log, tied to its request, with who did it and no email addresses.
        const event = (name: string) => logged.find((l) => l.event === name)
        const leased = event("office.lease.create.succeeded")!
        expect(leased.metadata).toMatchObject({ by: expect.stringMatching(/^admin:\d+$/), unitId: unit.body.id, leaseId: lease.body.id, invited: [invite.tenantId] })
        expect(event("auth.signup.succeeded")!.metadata).toMatchObject({ userId: `tenant:${invite.tenantId}` })
        expect(event("payment.office.succeeded")!.metadata).toMatchObject({ leaseId: lease.body.id, amount: 300, confirmation: paid.body.confirmation })
        expect(event("office.lease.create.failed")!.metadata).toMatchObject({ code: "UNIT_OCCUPIED" })
        const completed = logged.find((l) => l.event === "request.completed" && l.request_id === leased.request_id)!
        expect(completed.metadata).toMatchObject({ method: "POST", path: "/api/manager/leases", statusCode: 201 })
        expect(logged.find((l) => l.event === "request.completed" && l.metadata?.error === "UNIT_OCCUPIED")).toBeDefined()
        expect(logged.find((l) => l.event === "auth.login.failed" && l.metadata?.reason === "unknown email")).toBeDefined()
        const signupLine = logged.find((l) => l.event === "request.completed" && l.metadata?.path === "/api/auth/signup")!
        expect(JSON.stringify(signupLine)).not.toContain(invite.inviteToken)
        expect(JSON.stringify(logged)).not.toContain("@example.com")
    })

    it("passes plaid's error code and request id through to the browser, and lets Plaid Link load in production", async () => {
        const failing = {
            createLinkToken: async () => { throw new AppError("PLAID_ERROR", { operation: "link_token_create", plaidCode: "INVALID_API_KEYS", requestId: "req1", message: "invalid client_id or secret provided" }) },
            exchangeAndGetAuth: async () => { throw new Error("not called") },
        }
        const production = loadConfig({ NODE_ENV: "production", JWT_ACCESS_SECRET: "p".repeat(32), WEB_ORIGIN: ORIGIN })
        const prodServer = createApp(createContainer({ config: production, db: t.db, plaid: failing })).listen(0)
        await new Promise((resolve) => prodServer.once("listening", resolve))
        try {
            const base = `http://127.0.0.1:${(prodServer.address() as AddressInfo).port}`
            const csp = (await fetch(`${base}/health/live`)).headers.get("content-security-policy") ?? ""
            const page = (await fetch(`${base}/api/nope`)).headers.get("content-security-policy") ?? ""
            expect(csp + page).toMatch(/script-src[^;]*https:\/\/cdn\.plaid\.com/)
            expect(csp + page).toMatch(/frame-src[^;]*https:\/\/cdn\.plaid\.com/)

            const tenant = new Client(`${base}/api`)
            expect((await tenant.post("/auth/login", TENANT)).status).toBe(200)
            expect(await tenant.post("/create_link_token")).toMatchObject({
                status: 502,
                body: { error: "PLAID_ERROR", details: { plaidCode: "INVALID_API_KEYS", requestId: "req1" } },
            })
        } finally {
            await new Promise((resolve) => prodServer.close(resolve))
        }
    })

    it("production records no test transfers: without Plaid, a tenant cannot pay online", async () => {
        const production = loadConfig({ NODE_ENV: "production", JWT_ACCESS_SECRET: "p".repeat(32), WEB_ORIGIN: ORIGIN })
        const prodApp = createApp(createContainer({ config: production, db: t.db, plaid: null }))
        const prodServer = prodApp.listen(0)
        await new Promise((resolve) => prodServer.once("listening", resolve))
        try {
            const tenant = new Client(`http://127.0.0.1:${(prodServer.address() as AddressInfo).port}/api`)
            expect((await tenant.post("/auth/login", TENANT)).status).toBe(200)
            const summary = await tenant.get("/tenant/summary")
            expect(summary.body).toMatchObject({ plaidEnabled: false, testPayments: false })
            const pay = await tenant.post("/tenant/payments", { amount: 10 })
            expect(pay).toMatchObject({ status: 503, body: { error: "PLAID_NOT_CONFIGURED" } })
        } finally {
            await new Promise((resolve) => prodServer.close(resolve))
        }
    })

    it("answers unknown API paths with a JSON 404 and checks the origin on writes", async () => {
        const nf = await anonymous().get("/nope")
        expect(nf.status).toBe(404)
        expect(nf.body.error).toBe("NOT_FOUND")
        const evil = await anonymous().post("/auth/login", ADMIN, { origin: "https://evil.example" })
        expect(evil.status).toBe(403)
    })
})
