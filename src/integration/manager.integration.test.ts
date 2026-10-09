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

    it("receipts: stored with the office payment, checked by type, viewable by staff only", async () => {
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("receipt image bytes")])
        const units = (await json("GET", "/manager/units", manager)).body.units as Array<{ unitNum: string; leaseId: number | null; tenants: Array<{ id: number }> }>
        const u102 = units.find((u) => u.unitNum === "102")!

        const paid = await json("POST", `/manager/leases/${u102.leaseId}/payments`, manager, {
            amount: 100, method: "Money order", receipt: { filename: "money order #4471.png", data: png.toString("base64") },
        })
        expect(paid.status).toBe(201)
        const lease = (await json("GET", `/manager/leases/${u102.leaseId}`, manager)).body as { receiptPaymentIds: number[]; ledger: Array<{ id: string; confirmation?: string }> }
        const entry = lease.ledger.find((e) => e.confirmation === paid.body.confirmation)!
        const payId = Number(entry.id.replace("payment-", ""))
        expect(lease.receiptPaymentIds).toContain(payId)

        const file = await call("GET", `/manager/leases/${u102.leaseId}/payments/${payId}/receipt`, manager)
        expect(file.headers.get("content-type")).toBe("image/png")
        expect(file.headers.get("content-disposition")).toBe('inline; filename="money order _4471.png"')
        expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true)
        expect((await call("GET", `/manager/leases/${u102.leaseId}/payments/${payId}/receipt`, tenant)).status).toBe(403)

        // Not an image or PDF, or too big: refused, and the payment is not saved either.
        const before = (await json("GET", `/manager/leases/${u102.leaseId}`, manager)).body.ledger.length
        const text = await json("POST", `/manager/leases/${u102.leaseId}/payments`, manager, {
            amount: 50, method: "Cash", receipt: { filename: "notes.txt", data: Buffer.from("just text").toString("base64") },
        })
        expect(text.body).toEqual({ error: "RECEIPT_INVALID" })
        const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4 * 1024 * 1024)])
        expect((await json("POST", `/manager/leases/${u102.leaseId}/payments`, manager, {
            amount: 50, method: "Cash", receipt: { filename: "big.pdf", data: big.toString("base64") },
        })).body).toEqual({ error: "RECEIPT_INVALID" })
        expect((await json("GET", `/manager/leases/${u102.leaseId}`, manager)).body.ledger.length).toBe(before)

        // Attach one later to an earlier payment; undoing the payment removes its receipt.
        const pdf = Buffer.from("%PDF-1.4\n% a receipt\n")
        const older = lease.ledger.find((e) => e.confirmation?.startsWith("CONF-"))!
        const olderId = Number(older.id.replace("payment-", ""))
        expect((await json("PUT", `/manager/leases/${u102.leaseId}/payments/${olderId}/receipt`, manager, { filename: "stub.pdf", data: pdf.toString("base64") })).status).toBe(200)
        expect((await call("GET", `/manager/leases/${u102.leaseId}/payments/${olderId}/receipt`, manager)).headers.get("content-type")).toBe("application/pdf")
        expect((await json("DELETE", `/manager/leases/${u102.leaseId}/payments/${payId}`, manager)).status).toBe(200)
        expect((await call("GET", `/manager/leases/${u102.leaseId}/payments/${payId}/receipt`, manager)).status).toBe(404)
    })

    it("deletes only what leaves the records honest", async () => {
        const del = (path: string, cookie = manager) => json("DELETE", path, cookie)
        const tenants = async () => (await json("GET", "/manager/tenants", manager)).body.tenants as Array<{ id: number; name: string }>

        // Tenants: not while on a current lease; yes once their lease has ended (A5 ended above).
        const raj = (await tenants()).find((t) => t.name === "Raj P. Johnson")!
        expect((await del(`/manager/tenants/${raj.id}`)).body).toEqual({ error: "TENANT_ON_LEASE" })
        const hana = (await tenants()).find((t) => t.name === "Hana Tanaka")!
        expect((await del(`/manager/tenants/${hana.id}`)).status).toBe(200)
        expect((await tenants()).some((t) => t.name === "Hana Tanaka")).toBe(false)
        const invited = await json("POST", "/manager/tenants", manager, { name: "Del Me", email: "del.me@example.com" })
        expect((await del(`/manager/tenants/${invited.body.id}`)).status).toBe(200)

        // Leases: a mistaken one with no payments goes; one with payments stays.
        const units = (await json("GET", "/manager/units", manager)).body.units as Array<{ id: number; unitNum: string; propertyId: number; propertyName: string; leaseId: number | null }>
        const u101 = units.find((u) => u.unitNum === "101")!
        expect((await del(`/manager/leases/${u101.leaseId}`)).body).toEqual({ error: "LEASE_HAS_PAYMENTS" })
        const u1a = units.find((u) => u.unitNum === "1A")!
        expect((await del(`/manager/leases/${u1a.leaseId}`)).status).toBe(200)
        expect((await json("GET", `/manager/leases/${u1a.leaseId}`, manager)).status).toBe(404)

        // Units and properties: only without lease history.
        expect((await del(`/manager/units/${u101.id}`)).body).toEqual({ error: "UNIT_HAS_LEASES" })
        expect((await del(`/manager/properties/${u101.propertyId}`)).body).toEqual({ error: "PROPERTY_HAS_LEASES" })
        const u108 = units.find((u) => u.unitNum === "108")!
        expect((await del(`/manager/units/${u108.id}`)).status).toBe(200)
        expect((await del(`/manager/units/${u1a.id}`)).status).toBe(200)
        expect((await del(`/manager/properties/${u1a.propertyId}`)).status).toBe(200)
        const props = (await json("GET", "/manager/properties", manager)).body.properties as Array<{ name: string }>
        expect(props.map((p) => p.name).sort()).toEqual(["Mesilla Court", "Woodcrest Apartments"])

        // Payments: the office's own entry can be undone; a tenant's payment cannot.
        const lease = (await json("GET", `/manager/leases/${u101.leaseId}`, manager)).body as { balance: number; ledger: Array<{ id: string; confirmation?: string }> }
        const office = lease.ledger.find((e) => e.confirmation?.startsWith("OFF-"))!
        const theirs = lease.ledger.find((e) => e.confirmation?.startsWith("CONF-"))!
        expect((await del(`/manager/leases/${u101.leaseId}/payments/${theirs.id.replace("payment-", "")}`)).body).toEqual({ error: "NOT_OFFICE_PAYMENT" })
        expect((await del(`/manager/leases/${u101.leaseId}/payments/${office.id.replace("payment-", "")}`)).status).toBe(200)
        expect((await json("GET", `/manager/leases/${u101.leaseId}`, manager)).body.balance).toBe(lease.balance + 950)

        // Maintenance: staff may delete requests; nobody else on staff side may delete tenants.
        // (The earlier "Smoke detector" request was on unit 1A, so deleting 1A took it along.)
        const a1 = units.find((u) => u.unitNum === "A1")!
        await json("POST", "/manager/maintenance", manager, { unitId: a1.id, title: "Filed by mistake" })
        const queue = (await json("GET", "/manager/maintenance", staff)).body.requests as Array<{ id: number; title: string }>
        expect(queue.some((r) => r.title === "Smoke detector chirping")).toBe(false)
        const smoke = queue.find((r) => r.title === "Filed by mistake")!
        expect((await del(`/manager/maintenance/${smoke.id}`, staff)).status).toBe(200)
        expect((await del(`/manager/maintenance/${smoke.id}`, staff)).status).toBe(404)
        expect((await del(`/manager/tenants/${raj.id}`, staff)).status).toBe(403)
        expect((await del(`/manager/maintenance/${queue[0]!.id}`, tenant)).status).toBe(403)
    })
})
