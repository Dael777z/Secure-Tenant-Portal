// M2 acceptance (proposal, Oct 23): "Tenants and managers authenticate; role
// controls and database-level cross-tenant probes pass."
//
// The probes go straight at the database as the app's own login (summit_app),
// with no WHERE clauses: whatever comes back is what row-level security lets
// through. Then the same questions over HTTP, the way a browser would ask.
// Runs on the full sample (15 tenants, 14 leases). Skipped without TEST_DATABASE_URL.
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import jwt from "jsonwebtoken"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("M2: authentication, role controls, cross-tenant probes", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let base: string
    let a: { tid: number; lease: number }        // tenant@example.com (Unit 101)
    let b: { tid: number; lease: number }        // james.johnson@example.com (Unit 102)
    let totals: { tenants: number; leases: number; payments: number; charges: number; tickets: number }

    /** Run raw SQL as the app's login, as `who` (the three settings the policies read). */
    async function probe<T = Record<string, unknown>>(who: [string, string, string], sql: string, params: unknown[] = []): Promise<T[]> {
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', $1, true), set_config('app.user_id', $2, true), set_config('app.user_role', $3, true)", who)
            return (await client.query(sql, params)).rows as T[]
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    }
    const asTenant = (x: { tid: number }): [string, string, string] => ["tenant", String(x.tid), ""]
    const count = async (sql: string) => Number((await t.owner.query(sql)).rows[0].n)

    beforeAll(async () => {
        t = await freshDatabase("it_m2")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })   // the full sample
        const who = async (email: string) => (await t.owner.query(
            "SELECT t.tID AS tid, lt.LeaseID AS lease FROM Tenants t JOIN Lease_Tenants lt ON lt.tID = t.tID WHERE t.Email = $1", [email])).rows[0]
        a = await who("tenant@example.com")
        b = await who("james.johnson@example.com")
        totals = {
            tenants: await count("SELECT count(*) AS n FROM Tenants"),
            leases: await count("SELECT count(*) AS n FROM Lease"),
            payments: await count("SELECT count(*) AS n FROM Payment"),
            charges: await count("SELECT count(*) AS n FROM Charge"),
            tickets: await count("SELECT count(*) AS n FROM Maintenance_T"),
        }
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

    describe("database-level probes (summit_app, no WHERE clause)", () => {
        it("the sample has other people's data to leak", () => {
            expect(totals.tenants).toBeGreaterThan(10)
            expect(totals.leases).toBeGreaterThan(10)
            expect(a.lease).not.toBe(b.lease)
        })

        it("a tenant reads only their own tenant row, lease, charges and payments", async () => {
            const tenants = await probe<{ tid: number }>(asTenant(a), "SELECT tID AS tid FROM Tenants")
            expect(tenants.map((r) => r.tid)).toEqual([a.tid])
            const leases = await probe<{ id: number }>(asTenant(a), "SELECT LeaseID AS id FROM Lease")
            expect(leases.map((r) => r.id)).toEqual([a.lease])
            const charges = await probe<{ id: number }>(asTenant(a), "SELECT DISTINCT LeaseID AS id FROM Charge")
            expect(charges.map((r) => r.id)).toEqual([a.lease])
            const payments = await probe<{ id: number }>(asTenant(a), "SELECT DISTINCT LeaseID AS id FROM Payment")
            expect(payments.every((r) => r.id === a.lease)).toBe(true)
            const balances = await probe<{ id: number }>(asTenant(a), "SELECT LeaseID AS id FROM lease_balance")
            expect(balances.map((r) => r.id)).toEqual([a.lease])
        })

        it("asking for another tenant's rows by id returns nothing", async () => {
            expect(await probe(asTenant(a), "SELECT * FROM Tenants WHERE tID = $1", [b.tid])).toEqual([])
            expect(await probe(asTenant(a), "SELECT * FROM Lease WHERE LeaseID = $1", [b.lease])).toEqual([])
            expect(await probe(asTenant(a), "SELECT * FROM Payment WHERE LeaseID = $1", [b.lease])).toEqual([])
            expect(await probe(asTenant(a), "SELECT * FROM Charge WHERE LeaseID = $1", [b.lease])).toEqual([])
        })

        it("a tenant sees only requests on their own unit, and no other tenant's bank links or receipts", async () => {
            const units = await probe<{ uid: number }>(asTenant(a), "SELECT DISTINCT m.uID AS uid FROM Maintenance_T m")
            const own = (await t.owner.query("SELECT uID AS uid FROM Lease WHERE LeaseID = $1", [a.lease])).rows[0].uid
            expect(units.every((r) => r.uid === own)).toBe(true)
            expect(await probe(asTenant(a), "SELECT * FROM Bank_Accounts WHERE tID <> $1", [a.tid])).toEqual([])
            expect(await probe(asTenant(a), "SELECT * FROM Payment_Receipts")).toEqual([])
        })

        it("a tenant cannot reach sessions or the audit log at all", async () => {
            await expect(probe(asTenant(a), "SELECT * FROM Refresh_Tokens")).rejects.toMatchObject({ code: "42501" })   // no grant at all
            await expect(probe(asTenant(a), "SELECT * FROM audit_log")).rejects.toMatchObject({ code: "42501" })
        })

        it("a tenant cannot write to the ledger or change another tenant", async () => {
            await expect(probe(asTenant(a), "INSERT INTO Payment (LeaseID, direction, amount, status, transaction_id) VALUES ($1, 'charge', 1, 'completed', 'PROBE-1')", [a.lease]))
                .rejects.toMatchObject({ code: "42501" })
            await expect(probe(asTenant(a), "INSERT INTO Charge (LeaseID, kind, amount, due_date) VALUES ($1, 'other', 1, current_date)", [a.lease]))
                .rejects.toMatchObject({ code: "42501" })
            expect(await probe(asTenant(a), "UPDATE Tenants SET Name = 'changed' WHERE tID = $1 RETURNING tID", [b.tid])).toEqual([])
        })

        it("nobody can delete a payment, not even a manager", async () => {
            await expect(probe(["admin", "1", "admin"], "DELETE FROM Payment")).rejects.toMatchObject({ code: "42501" })
        })

        it("with no identity, every table reads empty", async () => {
            for (const table of ["Tenants", "Lease", "Charge", "Payment", "Maintenance_T", "Property", "Units"]) {
                expect(await probe(["", "", ""], `SELECT 1 FROM ${table}`)).toEqual([])
            }
        })

        it("maintenance staff read the queue but no leases or money", async () => {
            const staffId = (await t.owner.query("SELECT admin_id FROM Admin WHERE email = 'maintenance@example.com'")).rows[0].admin_id
            const staff: [string, string, string] = ["admin", String(staffId), "maintenance_staff"]
            expect((await probe(staff, "SELECT 1 FROM Maintenance_T")).length).toBe(totals.tickets)
            for (const table of ["Lease", "Charge", "Payment", "lease_balance", "Bank_Accounts", "Payment_Receipts"]) {
                expect(await probe(staff, `SELECT 1 FROM ${table}`)).toEqual([])
            }
        })

        it("a manager sees the whole portfolio", async () => {
            expect((await probe(["admin", "1", "admin"], "SELECT 1 FROM Lease")).length).toBe(totals.leases)
            expect((await probe(["admin", "1", "admin"], "SELECT 1 FROM Payment")).length).toBe(totals.payments)
        })
    })

    describe("over HTTP", () => {
        /** A tiny browser that keeps cookies. */
        const browser = () => {
            const cookies = new Map<string, string>()
            const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
                const res = await fetch(`${base}${path}`, {
                    method,
                    headers: {
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                        ...(method === "GET" ? {} : { origin: config.webOrigin }),
                        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                        ...extra,
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
            return { call, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) }
        }
        const signIn = async (email: string, password: string) => {
            const c = browser()
            const res = await c.post("/auth/login", { email, password })
            expect(res.status).toBe(200)
            return c
        }

        it("each role signs in and is told its own permissions", async () => {
            const cases: Array<[string, string, string]> = [
                ["manager@example.com", PASSWORDS.staff, "admin"],
                ["maintenance@example.com", PASSWORDS.staff, "maintenance_staff"],
                ["tenant@example.com", PASSWORDS.tenant, "tenant"],
            ]
            for (const [email, password, role] of cases) {
                const c = await signIn(email, password)
                expect((await c.get("/auth/me")).body.user.role).toBe(role)
            }
            expect((await browser().post("/auth/login", { email: "tenant@example.com", password: "wrong-password" })).status).toBe(401)
        })

        it("tenant A's summary holds only tenant A's lease", async () => {
            const tenantA = await signIn("tenant@example.com", PASSWORDS.tenant)
            const tenantB = await signIn("james.johnson@example.com", PASSWORDS.tenant)
            const sa = JSON.stringify((await tenantA.get("/tenant/summary")).body)
            const sb = JSON.stringify((await tenantB.get("/tenant/summary")).body)
            expect(sa).toContain("101")
            expect(sa).not.toContain("James Johnson")
            expect(sb).not.toContain("Test Tenant")
        })

        it("a tenant cannot open the office routes, even for their own lease", async () => {
            const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
            for (const path of [`/manager/leases/${b.lease}`, `/manager/leases/${a.lease}`, "/manager/tenants", "/manager/dashboard", "/manager/maintenance"]) {
                expect((await tenant.get(path)).status).toBe(403)
            }
        })

        it("a token with a forged role, or no token, gets nowhere", async () => {
            expect((await browser().get("/tenant/summary")).status).toBe(401)
            // Signed with the wrong secret: rejected outright.
            const forged = jwt.sign({ sub: `tenant:${a.tid}`, role: "admin" }, "not-the-secret", { issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: 60 })
            expect((await browser().call("GET", "/manager/tenants", undefined, { cookie: `access_token=${forged}` })).status).toBe(401)
        })
    })
})
