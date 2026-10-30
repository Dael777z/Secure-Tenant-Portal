import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * What the office does all day, over HTTP, on the full sample portfolio: dashboard and updates, properties,
 * units, tenants, leases, office payments, the maintenance queue, finance periods and message boxes.
 */
const config = loadConfig({ NODE_ENV: "test" })
const tag = () => Math.random().toString(36).slice(2, 8)

describe.skipIf(!hasDatabase)("office workflows on the sample portfolio", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    let admin: Client

    const browser = () => new Client(host, config.webOrigin)
    /** Invites a tenant (no lease yet) and returns their id and invite token. */
    async function invite(name = "Invited Person") {
        const res = await admin.post("/api/manager/tenants", { name, email: `${tag()}@example.com` })
        expect(res.status).toBe(201)
        return { id: res.body.id as number, token: res.body.inviteToken as string, email: res.body.email as string | undefined, link: res.body.inviteLink as string }
    }
    /** A property with one empty unit. */
    async function emptyUnit(label = "Flow") {
        const property = await admin.post("/api/manager/properties", { name: `${label} ${tag()}`, address: "9 Test Rd" })
        const unit = await admin.post("/api/manager/units", { propertyId: property.body.id, unitNum: "U1" })
        return { propertyId: property.body.id as number, unitId: unit.body.id as number }
    }

    beforeAll(async () => {
        t = await freshDatabase("it_workflows")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })   // the full sample
        container = createContainer({ config, db: t.db, plaid: null })
        ;({ host, close } = await listen(createApp(container)))
        admin = await browser().signIn(ACCOUNTS.admin)
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    it("the dashboard adds up the portfolio and lists the latest activity, newest first", async () => {
        const res = await admin.get("/api/manager/dashboard")
        expect(res.status).toBe(200)
        const d = res.body
        expect(d.properties).toBeGreaterThan(0)
        expect(d.occupied + d.vacant).toBe(d.units)
        expect(d.expectedThisMonth).toBeGreaterThan(0)
        expect(d.recentActivity.length).toBeGreaterThan(0)
        expect(d.recentActivity.length).toBeLessThanOrEqual(8)
        const times = d.recentActivity.map((a: { at: string }) => a.at)
        expect([...times].sort().reverse()).toEqual(times)
        expect(new Set(d.recentActivity.map((a: { kind: string }) => a.kind))).toContain("payment")
        expect(d.updates.length).toBeLessThanOrEqual(6)
    })

    it("the updates queue flags overdue rent, new repair requests and tenants who have not signed up, worst first", async () => {
        const units = (await admin.get("/api/manager/units")).body.units as Array<{ id: number }>
        expect((await admin.post("/api/manager/maintenance", { unitId: units[0]!.id, title: "Dripping tap in the hall" })).status).toBe(201)
        const { updates } = (await admin.get("/api/manager/updates")).body as { updates: Array<{ kind: string; severity: number; title: string }> }
        const kinds = new Set(updates.map((u) => u.kind))
        for (const kind of ["overdue", "maintenance_new", "not_signed_up"]) expect(kinds, kind).toContain(kind)
        const severities = updates.map((u) => u.severity)
        expect([...severities].sort((a, b) => b - a)).toEqual(severities)
        expect(updates.find((u) => u.kind === "maintenance_new")!.title).toContain("New maintenance request")
    })

    it("properties and units: add, rename, refuse a clashing number, retire", async () => {
        const property = await admin.post("/api/manager/properties", { name: "Workflow Court", address: "9 Test Rd" })
        expect(property.status).toBe(201)
        const pid = property.body.id as number
        expect((await admin.put(`/api/manager/properties/${pid}`, { name: "Workflow Court II", address: "10 Test Rd" })).status).toBe(200)
        expect((await admin.get("/api/manager/properties")).body.properties.map((p: { name: string }) => p.name)).toContain("Workflow Court II")
        expect((await admin.put("/api/manager/properties/999999", { name: "Nope", address: "x" })).status).toBe(404)

        const a = (await admin.post("/api/manager/units", { propertyId: pid, unitNum: "A" })).body.id as number
        const b = (await admin.post("/api/manager/units", { propertyId: pid, unitNum: "B" })).body.id as number
        expect((await admin.put(`/api/manager/units/${b}`, { propertyId: pid, unitNum: "a" })).status).toBe(400)   // "A" and "a" are the same number
        expect((await admin.put(`/api/manager/units/${b}`, { propertyId: pid, unitNum: "C" })).status).toBe(200)
        expect((await admin.put("/api/manager/units/999999", { propertyId: pid, unitNum: "Z" })).status).toBe(404)
        expect((await admin.get(`/api/manager/units?propertyId=${pid}`)).body.units.map((u: { unitNum: string }) => u.unitNum).sort()).toEqual(["A", "C"])
        expect((await admin.get("/api/manager/units?propertyId=abc")).status).toBe(400)

        expect((await admin.delete(`/api/manager/units/${a}`)).status).toBe(200)
        expect((await admin.get(`/api/manager/units?propertyId=${pid}`)).body.units).toHaveLength(1)
        expect((await admin.delete(`/api/manager/properties/${pid}`)).status).toBe(200)
        expect((await admin.get("/api/manager/properties")).body.properties.map((p: { id: number }) => p.id)).not.toContain(pid)
        expect((await admin.delete("/api/manager/properties/999999")).status).toBe(404)
    })

    it("tenants: invite, re-invite (the old link dies), rename, retire", async () => {
        const first = await invite()
        expect(first.link).toContain("/signup?token=")
        const second = await admin.post(`/api/manager/tenants/${first.id}/invite`)
        expect(second.status).toBe(200)
        expect(second.body.inviteToken).not.toBe(first.token)

        expect((await browser().post("/api/auth/signup", { token: first.token, password: "long-enough-pw" })).status).toBe(403)   // old link
        expect((await browser().post("/api/auth/signup", { token: second.body.inviteToken, password: "long-enough-pw" })).status).toBe(201)
        const again = await admin.post(`/api/manager/tenants/${first.id}/invite`)
        expect(again.status).toBe(409)
        expect(again.body.error).toBe("TENANT_ALREADY_SIGNED_UP")

        expect((await admin.put(`/api/manager/tenants/${first.id}`, { name: "Renamed Person", phone: "505-555-0100" })).status).toBe(200)
        const listed = (await admin.get("/api/manager/tenants")).body.tenants.find((x: { id: number }) => x.id === first.id)
        expect(listed.name).toBe("Renamed Person")
        expect((await admin.put(`/api/manager/tenants/${first.id}`, { name: "", phone: "1" })).status).toBe(400)
        expect((await admin.put("/api/manager/tenants/999999", { name: "Ghost" })).status).toBe(404)

        expect((await admin.delete(`/api/manager/tenants/${first.id}`)).status).toBe(200)
        expect((await admin.get("/api/manager/tenants")).body.tenants.map((x: { id: number }) => x.id)).not.toContain(first.id)
    })

    it("tenants: refuses a bad email and an email already in use", async () => {
        expect((await admin.post("/api/manager/tenants", { name: "Bad Email", email: "nope" })).status).toBe(400)
        const email = `${tag()}@example.com`
        expect((await admin.post("/api/manager/tenants", { name: "One", email })).status).toBe(201)
        const dup = await admin.post("/api/manager/tenants", { name: "Two", email })
        expect(dup.status).toBe(409)
        expect(dup.body.error).toBe("EMAIL_IN_USE")
    })

    it("leases: create, change, refuse overlaps and bad dates, add and remove tenants", async () => {
        const { unitId } = await emptyUnit("Lease")
        const a = await invite("Tenant A")
        const lease = await admin.post("/api/manager/leases", { unitId, startDate: "2026-01-01", endDate: "2026-06-30", monthlyRent: 800, tenantIds: [a.id] })
        expect(lease.status).toBe(201)
        const leaseId = lease.body.id as number

        expect((await admin.post("/api/manager/leases", { unitId, startDate: "2026-07-01", monthlyRent: 800 })).status).toBe(400)   // nobody on it
        expect((await admin.post("/api/manager/leases", { unitId, startDate: "2026-07-01", endDate: "2026-06-01", monthlyRent: 800, tenantIds: [a.id] })).status).toBe(400)

        const next = await admin.post("/api/manager/leases", { unitId, startDate: "2026-07-01", endDate: "2026-12-31", monthlyRent: 800, newTenants: [{ name: "Next Tenant", email: `${tag()}@example.com` }] })
        expect(next.status).toBe(201)
        expect(next.body.invites).toHaveLength(1)

        expect((await admin.put(`/api/manager/leases/${leaseId}`, { endDate: "2026-08-31" })).status).toBe(409)     // would run into the next lease
        expect((await admin.put(`/api/manager/leases/${leaseId}`, { endDate: "2025-12-31" })).status).toBe(400)     // ends before it starts
        expect((await admin.put(`/api/manager/leases/${leaseId}`, { monthlyRent: 850 })).status).toBe(200)
        expect(JSON.stringify((await admin.get(`/api/manager/leases/${leaseId}`)).body)).toContain("850")
        expect((await admin.get("/api/manager/leases/999999")).status).toBe(404)

        const b = await invite("Tenant B")
        expect((await admin.post(`/api/manager/leases/${leaseId}/tenants`, { tenantId: b.id })).status).toBe(201)
        const withNew = await admin.post(`/api/manager/leases/${leaseId}/tenants`, { newTenant: { name: "Newcomer", email: `${tag()}@example.com` } })
        expect(withNew.status).toBe(201)
        expect(withNew.body.invite.inviteLink).toContain("/signup?token=")
        expect((await admin.post(`/api/manager/leases/${leaseId}/tenants`, { tenantId: 999999 })).status).toBe(404)
        expect((await admin.post("/api/manager/leases/999999/tenants", { tenantId: b.id })).status).toBe(404)
        expect((await admin.post(`/api/manager/leases/${leaseId}/tenants`, {})).status).toBe(400)

        expect((await admin.delete(`/api/manager/leases/${leaseId}/tenants/${b.id}`)).status).toBe(200)
        expect((await admin.delete(`/api/manager/leases/${leaseId}/tenants/${b.id}`)).status).toBe(404)
    })

    it("office payments: record one, reverse it once", async () => {
        const leaseId = (await t.owner.query("SELECT LeaseID AS id FROM Lease ORDER BY LeaseID LIMIT 1")).rows[0].id
        expect((await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 120, method: "Money order" })).status).toBe(201)
        const paymentId = (await t.owner.query("SELECT max(payID) AS id FROM Payment")).rows[0].id
        expect((await admin.delete(`/api/manager/leases/${leaseId}/payments/${paymentId}`)).status).toBe(200)
        const twice = await admin.delete(`/api/manager/leases/${leaseId}/payments/${paymentId}`)
        expect(twice.status).toBe(409)
        expect(twice.body.error).toBe("PAYMENT_ALREADY_REVERSED")
        expect((await admin.post(`/api/manager/leases/${leaseId}/payments`, { amount: 120, method: "Bitcoin" })).status).toBe(400)
    })

    it("maintenance queue: file, move along, refuse a bad status, remove", async () => {
        const queue = (await admin.get("/api/manager/maintenance")).body
        expect(queue.units.length).toBeGreaterThan(0)
        const created = await admin.post("/api/manager/maintenance", { unitId: queue.units[0].id, title: "Broken window latch", description: "Second floor" })
        expect(created.status).toBe(201)
        const id = created.body.id as number
        expect((await admin.post("/api/manager/maintenance", { unitId: queue.units[0].id })).status).toBe(400)   // no title
        expect((await admin.put(`/api/manager/maintenance/${id}`, { status: "in_progress" })).status).toBe(200)
        expect((await admin.put(`/api/manager/maintenance/${id}`, { status: "bogus" })).status).toBe(400)
        expect((await admin.get("/api/manager/maintenance")).body.requests.find((r: { id: number }) => r.id === id).status).toBe("in_progress")
        expect((await admin.delete(`/api/manager/maintenance/${id}`)).status).toBe(200)
        expect((await admin.get("/api/manager/maintenance")).body.requests.map((r: { id: number }) => r.id)).not.toContain(id)
    })

    it("finance: every period answers, and an unknown one is refused", async () => {
        for (const [period, label] of [["this-month", "to date"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["12m", "Last 12 months"], ["ytd", "year to date"]]) {
            const res = await admin.get(`/api/manager/finance?period=${period}`)
            expect(res.status, period).toBe(200)
            expect(JSON.stringify(res.body), period).toContain(label)
        }
        expect((await admin.get("/api/manager/finance?period=forever")).status).toBe(400)
    })

    it("messages: the archived box answers, an unknown box is refused, replying to nobody is a 404", async () => {
        expect((await admin.get("/api/manager/messages?box=archived")).status).toBe(200)
        expect((await admin.get("/api/manager/messages?box=spam")).status).toBe(400)
        expect((await admin.post("/api/manager/messages/999999", { body: "Hello?" })).status).toBe(404)
    })

    it("staff see their own profile, each with their own role", async () => {
        expect((await admin.get("/api/manager/me")).body).toMatchObject({ email: ACCOUNTS.admin.email, role: "admin" })
        const staff = await browser().signIn(ACCOUNTS.maintenance)
        expect((await staff.get("/api/manager/me")).body).toMatchObject({ email: ACCOUNTS.maintenance.email, role: "maintenance_staff" })
    })

    it("a tenant with no lease can sign in but has no rent to pay and no unit to report on", async () => {
        const person = await invite("No Lease")
        const password = "no-lease-pw-12"
        expect((await browser().post("/api/auth/signup", { token: person.token, password })).status).toBe(201)
        const me = await browser().signIn({ email: person.email ?? (await t.owner.query("SELECT email FROM Tenants WHERE tID = $1", [person.id])).rows[0].email, password })
        const pay = await me.post("/api/tenant/payments", { amount: 10 })
        expect(pay.status).toBe(404)
        expect(pay.body.error).toBe("NO_ACTIVE_LEASE")
        const ticket = await me.post("/api/tenant/maintenance", { title: "No unit to report on" })
        expect(ticket.status).toBe(404)
        expect(ticket.body.error).toBe("NO_ACTIVE_LEASE")
    })

    it("a tenant retired by the office while signed in is shut out at once", async () => {
        const person = await invite("Retired")
        const password = "retired-pw-12345"
        await browser().post("/api/auth/signup", { token: person.token, password })
        const email = (await t.owner.query("SELECT email FROM Tenants WHERE tID = $1", [person.id])).rows[0].email
        const me = await browser().signIn({ email, password })
        expect((await admin.delete(`/api/manager/tenants/${person.id}`)).status).toBe(200)
        expect((await me.get("/api/tenant/summary")).status).toBe(404)
        expect((await browser().post("/api/auth/login", { email, password })).status).toBe(401)
    })
})
