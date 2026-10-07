// The manager side's API on Postgres, over HTTP, with the demo seed.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "http"
import type { AddressInfo } from "net"
import type { Pool } from "pg"
import pino from "pino"
import { createApp } from "../create-app"
import { LogService } from "../logging/log-service"
import { PostgresDatabase } from "../services/postgres-db"
import { TenantStore } from "../services/tenant-store"
import { ManagerStore } from "../services/manager-store"
import { seed } from "../db/seed"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_manager"
const NOW = new Date("2026-10-07T18:00:00Z")

describe.skipIf(!hasDatabase)("manager API on Postgres", () => {
    let pool: Pool
    let server: Server
    let base: string
    let manager = ""
    let staff = ""
    let tenant = ""

    const call = (method: string, path: string, cookie: string, body?: unknown) =>
        fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = async (method: string, path: string, cookie: string, body?: unknown) => {
        const res = await call(method, path, cookie, body)
        return { status: res.status, body: await res.json().catch(() => null) }
    }
    const signIn = async (email: string, password: string) => {
        const res = await call("POST", "/auth/login", "", { email, password })
        expect(res.status).toBe(200)
        return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
    }

    beforeAll(async () => {
        pool = await freshSchema(SCHEMA)
        await seed(pool, { adminEmail: "manager@example.com", adminPassword: "manager password", bcryptRounds: 4, tenantPassword: "tenant password", today: NOW })
        const db = new PostgresDatabase(pool)
        const options = { timeZone: "America/Denver", now: () => NOW }
        const app = createApp({
            database: db,
            logger: new LogService(pino({ level: "silent" })),
            distRoot: __dirname,
            tenantStore: new TenantStore(pool, options),
            managerStore: new ManagerStore(pool, db, options),
        })
        server = app.listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
        manager = await signIn("manager@example.com", "manager password")
        staff = await signIn("maintenance@example.com", "manager password")
        tenant = await signIn("tenant@example.com", "tenant password")
    })

    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        if (pool) await dropSchema(pool, SCHEMA)
    })

    it("the dashboard counts the seeded portfolio", async () => {
        const { status, body } = await json("GET", "/manager/dashboard", manager)
        expect(status).toBe(200)
        expect(body).toMatchObject({ properties: 2, units: 18, occupied: 14, vacant: 4 })
        expect(body.overdueAccounts).toBeGreaterThanOrEqual(5)
        expect(body.openMaintenance).toBe(4)
        expect(body.collectedThisMonth).toBeGreaterThan(0)
        expect(body.updates[0].kind).toBe("overdue")
        expect(body.recentActivity.length).toBeGreaterThan(0)
    })

    it("the rent roll knows who owes what", async () => {
        const { body } = await json("GET", "/manager/units", manager)
        const byUnit = new Map(body.units.map((u: { unitNum: string }) => [u.unitNum, u]))
        expect(byUnit.get("101")).toMatchObject({ status: "owing", balance: 950, monthlyRent: 950, tenants: [{ name: "Test Tenant" }] })
        expect(byUnit.get("102")).toMatchObject({ status: "owing", balance: 1820 })
        expect(byUnit.get("103")).toMatchObject({ status: "current", balance: 0 })
        expect(byUnit.get("104")).toMatchObject({ status: "owing", balance: 500 })
        expect(byUnit.get("108")).toMatchObject({ status: "vacant", leaseId: null, tenants: [] })
        expect((byUnit.get("105") as { tenants: unknown[] }).tenants).toHaveLength(2)
    })

    it("a property, a unit, and a lease with an existing and a new tenant", async () => {
        const property = await json("POST", "/manager/properties", manager, { name: "Desert Rose", address: "9 Rose Ln, Las Cruces, NM" })
        expect(property.status).toBe(201)
        const unit = await json("POST", "/manager/units", manager, { propertyId: property.body.id, unitNum: "1A" })
        expect(unit.status).toBe(201)
        expect((await json("POST", "/manager/units", manager, { propertyId: property.body.id, unitNum: "1a" })).status).toBe(400)

        const tenants = (await json("GET", "/manager/tenants", manager)).body.tenants
        const nora = tenants.find((t: { email: string }) => t.email === "nora.brooks@example.com")
        expect(nora.signedUp).toBe(false)

        const lease = await json("POST", "/manager/leases", manager, {
            unitId: unit.body.id,
            startDate: "2026-10-01",
            monthlyRent: 1100,
            tenantIds: [],
            newTenants: [{ name: "Ivy Park", email: "Ivy.Park@example.com", phone: "" }],
        })
        expect(lease.status).toBe(201)
        const detail = (await json("GET", `/manager/leases/${lease.body.id}`, manager)).body
        expect(detail).toMatchObject({ unitNum: "1A", propertyName: "Desert Rose", monthlyRent: 1100, balance: 1100 })
        expect(detail.tenants).toEqual([{ id: expect.any(Number), name: "Ivy Park", email: "ivy.park@example.com", phone: null, signedUp: false }])

        // The invited tenant can now sign up themselves.
        const signup = await call("POST", "/auth/signup", "", { email: "ivy.park@example.com", password: "long enough" })
        expect(signup.status).toBe(201)

        // An occupied unit cannot get a second lease.
        const again = await json("POST", "/manager/leases", manager, { unitId: unit.body.id, startDate: "2026-10-01", monthlyRent: 900, newTenants: [{ name: "X", email: "x@example.com" }] })
        expect(again.status).toBe(409)

        const props = (await json("GET", "/manager/properties", manager)).body.properties
        expect(props.find((p: { name: string }) => p.name === "Desert Rose")).toMatchObject({ units: 1, occupied: 1, monthlyRent: 1100, outstanding: 1100 })
    })

    it("recording an office payment shows on the lease and for the tenant", async () => {
        const units = (await json("GET", "/manager/units", manager)).body.units
        const u101 = units.find((u: { unitNum: string; propertyName: string }) => u.unitNum === "101")
        const paid = await json("POST", `/manager/leases/${u101.leaseId}/payments`, manager, { amount: 950, method: "Check", tenantId: u101.tenants[0].id })
        expect(paid.status).toBe(201)
        expect(paid.body.confirmation).toMatch(/^OFF-/)

        const lease = (await json("GET", `/manager/leases/${u101.leaseId}`, manager)).body
        expect(lease.balance).toBe(0)
        expect(lease.ledger[0]).toMatchObject({ description: "Payment received", method: "Check (recorded by office)", amount: 950 })

        const tenantView = (await json("GET", "/tenant/summary", tenant)).body
        expect(tenantView.currentBalance).toBe(0)
        expect((await json("POST", `/manager/leases/${u101.leaseId}/payments`, manager, { amount: 10, method: "Bitcoin" })).status).toBe(400)
    })

    it("cosigners: add one, remove one, but a lease keeps at least one", async () => {
        const units = (await json("GET", "/manager/units", manager)).body.units
        const u106 = units.find((u: { unitNum: string }) => u.unitNum === "106")
        expect((await json("POST", `/manager/leases/${u106.leaseId}/tenants`, manager, { newTenant: { name: "Sam Sharma", email: "sam.sharma@example.com" } })).status).toBe(201)
        let lease = (await json("GET", `/manager/leases/${u106.leaseId}`, manager)).body
        expect(lease.tenants.map((t: { name: string }) => t.name)).toEqual(["Priya Sharma", "Sam Sharma"])
        const sam = lease.tenants.find((t: { name: string }) => t.name === "Sam Sharma")
        expect((await json("DELETE", `/manager/leases/${u106.leaseId}/tenants/${sam.id}`, manager)).status).toBe(200)
        lease = (await json("GET", `/manager/leases/${u106.leaseId}`, manager)).body
        expect((await json("DELETE", `/manager/leases/${u106.leaseId}/tenants/${lease.tenants[0].id}`, manager)).status).toBe(400)
    })

    it("ending a lease frees the unit; rent changes apply to the whole lease", async () => {
        const units = (await json("GET", "/manager/units", manager)).body.units
        const a5 = units.find((u: { unitNum: string }) => u.unitNum === "A5")
        expect((await json("PUT", `/manager/leases/${a5.leaseId}`, manager, { endDate: "2026-10-05" })).status).toBe(200)
        const after = (await json("GET", "/manager/units", manager)).body.units.find((u: { unitNum: string }) => u.unitNum === "A5")
        expect(after.status).toBe("vacant")
        expect((await json("PUT", `/manager/leases/${a5.leaseId}`, manager, { endDate: "2020-01-01" })).status).toBe(400)
    })

    it("tenant contact details can be corrected", async () => {
        const tenants = (await json("GET", "/manager/tenants", manager)).body.tenants
        const raj = tenants.find((t: { name: string }) => t.name === "Raj Johnson")
        expect((await json("PUT", `/manager/tenants/${raj.id}`, manager, { name: "Raj P. Johnson", phone: "(575) 555-0107" })).status).toBe(200)
        const again = (await json("GET", "/manager/tenants", manager)).body.tenants.find((t: { id: number }) => t.id === raj.id)
        expect(again).toMatchObject({ name: "Raj P. Johnson", phone: "(575) 555-0107" })
        expect((await json("POST", "/manager/tenants", manager, { name: "Dup", email: "manager@example.com" })).status).toBe(409)
    })

    it("maintenance: staff see the queue and move a request along; the tenant sees the change", async () => {
        const queue = await json("GET", "/manager/maintenance", staff)
        expect(queue.status).toBe(200)
        expect(queue.body.requests.length).toBe(6)
        const faucet = queue.body.requests.find((r: { title: string }) => r.title === "Kitchen faucet leaking")
        expect((await json("PUT", `/manager/maintenance/${faucet.id}`, staff, { status: "resolved" })).status).toBe(200)
        const mine = (await json("GET", "/tenant/summary", tenant)).body.maintenanceRequests
        expect(mine.find((r: { title: string }) => r.title === "Kitchen faucet leaking").status).toBe("resolved")

        const unitId = queue.body.units[0].id
        expect((await json("POST", "/manager/maintenance", manager, { unitId, title: "Smoke detector chirping" })).status).toBe(201)
        expect((await json("PUT", `/manager/maintenance/${faucet.id}`, staff, { status: "closed" })).status).toBe(400)
    })

    it("staff see their own name; tenants cannot ask", async () => {
        expect((await json("GET", "/manager/me", manager)).body).toMatchObject({ name: "Dana Whitfield", email: "manager@example.com", role: "property_manager" })
        expect((await json("GET", "/manager/me", staff)).body).toMatchObject({ name: "Ray Ortiz", role: "maintenance_staff" })
        expect((await json("GET", "/manager/me", tenant)).status).toBe(403)
    })

    it("each role reaches only its part", async () => {
        expect((await json("GET", "/manager/dashboard", staff)).status).toBe(403)
        expect((await json("POST", "/manager/properties", staff, { name: "X", address: "Y" })).status).toBe(403)
        expect((await json("GET", "/manager/dashboard", tenant)).status).toBe(403)
        expect((await json("GET", "/manager/maintenance", tenant)).status).toBe(403)
        expect((await json("GET", "/manager/dashboard", "")).status).toBe(401)
    })

    it("the updates list puts the biggest problems first", async () => {
        const { body } = await json("GET", "/manager/updates", manager)
        expect(body.updates[0]).toMatchObject({ kind: "overdue", unitLabel: "Unit 102 - Woodcrest Apartments" })
        expect(body.updates.some((u: { kind: string }) => u.kind === "maintenance_new")).toBe(true)
        expect(body.updates.some((u: { kind: string; detail: string }) => u.kind === "not_signed_up" && u.detail.includes("Nora Brooks"))).toBe(true)
    })
})
