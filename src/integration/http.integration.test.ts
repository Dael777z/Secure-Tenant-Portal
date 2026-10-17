import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createApp } from "../create-app"
import { createContainer, type Container } from "../container"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * The whole stack over HTTP: createApp(createContainer(...)) on a freshly
 * seeded test database, driven with fetch like the browser does.
 */
const ADMIN = { email: "manager@example.com", password: PASSWORDS.staff }
const TENANT = { email: "tenant@example.com", password: PASSWORDS.tenant }
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

    beforeAll(async () => {
        t = await freshDatabase("portal_http_test")
        await seed(t.owner, { dataset: "clean", webOrigin: ORIGIN, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
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

    it("shows a tenant their own summary, and lets them pay and file a request", async () => {
        const tenant = await signedIn(TENANT)
        const before = await tenant.get("/tenant/summary")
        expect(before.status).toBe(200)

        expect(before.body).toMatchObject({ plaidEnabled: false, testPayments: true })
        const pay = await tenant.post("/tenant/payments", { amount: 100 })   // development: a test transfer
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
