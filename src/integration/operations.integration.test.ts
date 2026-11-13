import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { runAs, SYSTEM } from "../db/identity"
import { samplePdf, seed } from "../db/seed"
import { localDate } from "../services/ledger"
import { ACCOUNTS, Client, createTenant, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * RentRedi-style management (008) over HTTP on the sample portfolio: Rent &
 * Charges, repeating charges, the unit page, lease PDFs, late fee rules and the
 * job that posts them, rent reminders, the team, office notifications, the
 * maintenance stages, and who may do what.
 */
const config = loadConfig({ NODE_ENV: "test" })
const today = () => localDate(new Date(), config.timeZone)

describe.skipIf(!hasDatabase)("RentRedi-style management (008)", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    let admin: Client
    let tenant: Client
    let maint: Client
    let leaseId: number
    let unitId: number
    let propertyId: number

    const count = async (sql: string, params: unknown[] = []) => (await t.owner.query<{ n: number }>(sql, params)).rows[0]!.n

    beforeAll(async () => {
        t = await freshDatabase("it_operations")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        ;({ host, close } = await listen(createApp(container)))
        admin = await new Client(host, config.webOrigin).signIn(ACCOUNTS.admin)
        tenant = await new Client(host, config.webOrigin).signIn(ACCOUNTS.tenant)
        maint = await new Client(host, config.webOrigin).signIn(ACCOUNTS.maintenance)
        const row = (await t.owner.query(
            `SELECT lt.LeaseID AS "leaseId", l.uID AS "unitId", u.pID AS "propertyId" FROM Tenants t JOIN Lease_Tenants lt ON lt.tID = t.tID
               JOIN Lease l ON l.LeaseID = lt.LeaseID JOIN Units u ON u.uID = l.uID WHERE t.Email = $1`, [ACCOUNTS.tenant.email])).rows[0]
        ;({ leaseId, unitId, propertyId } = row)
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    describe("Rent & Charges", () => {
        it("lists this month's charges with paid, due and late totals that add up", async () => {
            const res = await admin.get("/api/manager/charges")
            expect(res.status).toBe(200)
            const v = res.body
            expect(v.from).toBe(`${today().slice(0, 7)}-01`)
            expect(v.rows.length).toBeGreaterThan(0)
            const sum = (k: string) => Math.round(v.rows.reduce((s: number, r: Record<string, number>) => s + r[k]!, 0) * 100) / 100
            expect(v.summary.charged).toBeCloseTo(sum("amount"), 2)
            expect(v.summary.paid).toBeCloseTo(sum("paid"), 2)
            expect(v.summary.due + v.summary.late).toBeCloseTo(sum("unpaid"), 2)
            expect(v.allTimeLate).toBeGreaterThanOrEqual(v.summary.late)
            for (const r of v.rows) {
                expect(["paid", "due", "late"]).toContain(r.status)
                if (r.status === "paid") expect(r.unpaid).toBe(0)
                if (r.paid > 0) expect(["manual", "online", "both"]).toContain(r.source)
            }
        })

        it("takes any date range, and refuses one that ends before it starts", async () => {
            const all = await admin.get("/api/manager/charges?from=2000-01-01&to=2099-12-31")
            expect(all.body.rows.length).toBeGreaterThan((await admin.get("/api/manager/charges")).body.rows.length)
            expect((await admin.get("/api/manager/charges?from=2026-10-01&to=2026-09-01")).status).toBe(400)
            expect((await admin.get("/api/manager/charges?from=nope")).status).toBe(400)
        })

        it("adds a charge that repeats monthly, on the same day (the last day in shorter months)", async () => {
            const res = await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "parking", amount: 40, dueDate: "2027-01-31", description: "Parking spot 4", occurrences: 3 })
            expect(res.status).toBe(201)
            expect(res.body.ids).toHaveLength(3)
            const { rows } = await t.owner.query("SELECT due_date AS d, kind FROM Charge WHERE chargeID = ANY($1) ORDER BY due_date", [res.body.ids])
            expect(rows.map((r) => r.d)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"])
            expect(rows.every((r) => r.kind === "parking")).toBe(true)
        })

        it("a single charge still works, and bad kinds, counts and leases are refused", async () => {
            expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "hoa", amount: 75, dueDate: "2026-12-01" })).body.ids).toHaveLength(1)
            expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "rent", amount: 75, dueDate: "2026-12-01" })).status).toBe(400)
            expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "hoa", amount: 75, dueDate: "2026-12-01", occurrences: 25 })).status).toBe(400)
            expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "hoa", amount: 75, dueDate: "2026-12-01", occurrences: "2" })).status).toBe(400)
            expect((await admin.post(`/api/manager/leases/${leaseId}/charges`, { kind: "hoa", amount: 75, dueDate: "2026-12-01", occurrences: 1.5 })).status).toBe(400)
            expect((await admin.post("/api/manager/leases/999999/charges", { kind: "hoa", amount: 75, dueDate: "2026-12-01" })).status).toBe(404)
        })
    })

    describe("the unit page and documents", () => {
        it("shows the unit's leases, its current lease, performance and requests", async () => {
            const res = await admin.get(`/api/manager/units/${unitId}`)
            expect(res.status).toBe(200)
            expect(res.body.leaseId).toBe(leaseId)
            expect(res.body.leases.find((l: { id: number }) => l.id === leaseId).state).toBe("current")
            expect(res.body.performance.monthsLeased).toBeGreaterThan(0)
            expect(res.body.performance.billed).toBeGreaterThan(0)
            expect(res.body.maintenance.length).toBeGreaterThan(0)
            expect((await admin.get("/api/manager/units/999999")).status).toBe(404)
        })

        it("stores a signed lease PDF, lists it with the receipts, and serves it to the office and the tenant", async () => {
            expect((await tenant.get("/api/tenant/lease-document")).status).toBe(404)
            const pdf = samplePdf("Lease for the test")
            const up = await admin.put(`/api/manager/leases/${leaseId}/document`, { filename: "Lease \"101\".pdf", data: pdf.toString("base64") })
            expect(up.status).toBe(200)
            const docs = (await admin.get("/api/manager/documents")).body.documents
            expect(docs.some((d: { kind: string; leaseId: number }) => d.kind === "lease" && d.leaseId === leaseId)).toBe(true)
            const file = await admin.get(`/api/manager/leases/${leaseId}/document`)
            expect(file.status).toBe(200)
            expect(file.headers.get("content-type")).toBe("application/pdf")
            expect(file.bytes.equals(pdf)).toBe(true)
            const mine = await tenant.get("/api/tenant/lease-document")
            expect(mine.status).toBe(200)
            expect(mine.bytes.subarray(0, 5).toString()).toBe("%PDF-")
            expect((await tenant.get("/api/tenant/summary")).body.leaseDocument.filename).toBe("Lease _101_.pdf")
            // Replacing it keeps one per lease; the unit page shows it.
            expect((await admin.put(`/api/manager/leases/${leaseId}/document`, { filename: "v2.pdf", data: pdf.toString("base64") })).status).toBe(200)
            expect(await count("SELECT count(*)::int AS n FROM Lease_Documents WHERE LeaseID = $1", [leaseId])).toBe(1)
            expect((await admin.get(`/api/manager/units/${unitId}`)).body.leases.find((l: { id: number }) => l.id === leaseId).document.filename).toBe("v2.pdf")
        })

        it("refuses a file that is not a PDF, bad base64, or another lease's document", async () => {
            expect((await admin.put(`/api/manager/leases/${leaseId}/document`, { filename: "x.pdf", data: Buffer.from("not a pdf").toString("base64") })).status).toBe(400)
            expect((await admin.put(`/api/manager/leases/${leaseId}/document`, { filename: "x.pdf", data: "!!" })).status).toBe(400)
            expect((await admin.put("/api/manager/leases/999999/document", { filename: "x.pdf", data: samplePdf("x").toString("base64") })).status).toBe(404)
            expect((await admin.get("/api/manager/leases/999999/document")).status).toBe(404)
        })
    })

    describe("late fee rules and the job that posts them", () => {
        let ruleId: number

        it("saves a rule for all properties and says which rule each unit gets", async () => {
            const res = await admin.post("/api/manager/late-fee-rules", { graceDays: 5, firstAmount: 50, firstType: "flat", dailyAmount: 10, maxAmount: 100 })
            expect(res.status).toBe(201)
            ruleId = res.body.id
            const list = (await admin.get("/api/manager/late-fee-rules")).body
            expect(list.rules).toHaveLength(1)
            expect(list.rules[0].label).toBe("All properties")
            expect(list.units.every((u: { source: string }) => u.source === "all")).toBe(true)
        })

        it("posts fees for late rent once a day per rent charge, within the limit, and a second run adds nothing", async () => {
            // Pretend the rule has been in place for a year, so overdue rent gets its fees.
            await t.owner.query("UPDATE Late_Fee_Rules SET created_at = now() - interval '365 days' WHERE ruleID = $1", [ruleId])
            const day = today()
            const first = await runAs(SYSTEM, () => t.db.applyLateFees(day, config.timeZone))
            expect(first).toBeGreaterThan(0)
            expect(await runAs(SYSTEM, () => t.db.applyLateFees(day, config.timeZone))).toBe(0)
            // No rent charge gets more than $100 of fees, and the first one is $50 on day 5.
            const { rows } = await t.owner.query(
                `SELECT lp.rent_chargeID AS id, sum(c.amount)::float AS total, min(lp.days_late) AS first FROM Late_Fee_Postings lp
                   JOIN Charge c ON c.chargeID = lp.fee_chargeID GROUP BY lp.rent_chargeID`)
            expect(rows.length).toBeGreaterThan(0)
            for (const r of rows) {
                expect(r.total).toBeLessThanOrEqual(100)
                expect(r.first).toBe(5)
            }
        })

        it("only the office or the system can run it", async () => {
            expect(await t.db.applyLateFees(today(), config.timeZone)).toBe(0)
            expect(await t.db.sendRentReminders(today(), config.timeZone)).toBe(0)
        })

        it("a unit's own rule wins over the property's and the rule for all", async () => {
            expect((await admin.post("/api/manager/late-fee-rules", { propertyId, graceDays: 3, firstAmount: 5, firstType: "percent" })).status).toBe(201)
            expect((await admin.post("/api/manager/late-fee-rules", { propertyId, unitId, graceDays: 1, firstAmount: 0, dailyAmount: 2 })).status).toBe(201)
            const units = (await admin.get("/api/manager/late-fee-rules")).body.units
            expect(units.find((u: { unitId: number }) => u.unitId === unitId).source).toBe("unit")
            expect(units.find((u: { unitId: number; propertyId: number }) => u.unitId !== unitId && u.propertyId === propertyId).source).toBe("property")
            expect(units.some((u: { source: string }) => u.source === "all")).toBe(true)
        })

        it("saving again for the same scope replaces the rule; turning it off keeps it on record", async () => {
            expect((await admin.post("/api/manager/late-fee-rules", { graceDays: 7, firstAmount: 25 })).status).toBe(201)
            expect(await count("SELECT count(*)::int AS n FROM Late_Fee_Rules WHERE pID IS NULL AND deactivated_at IS NULL")).toBe(1)
            const all = (await admin.get("/api/manager/late-fee-rules")).body.rules.find((r: { propertyId: number | null }) => r.propertyId === null)
            expect(all.graceDays).toBe(7)
            expect((await admin.delete(`/api/manager/late-fee-rules/${all.id}`)).status).toBe(200)
            expect((await admin.delete(`/api/manager/late-fee-rules/${all.id}`)).status).toBe(404)
            expect(await count("SELECT count(*)::int AS n FROM Late_Fee_Rules")).toBeGreaterThan(3)
        })

        it("refuses rules that charge nothing, percents over 100, and scopes that do not exist", async () => {
            const bad = [
                { graceDays: 5 },
                { graceDays: 5, firstAmount: 150, firstType: "percent" },
                { graceDays: 5, dailyAmount: 120, dailyType: "percent" },
                { graceDays: 5, firstAmount: 5, maxAmount: 101, maxType: "percent" },
                { graceDays: 61, firstAmount: 5 },
                { graceDays: -1, firstAmount: 5 },
                { graceDays: 5, firstAmount: 5, firstType: "half" },
                { unitId, graceDays: 5, firstAmount: 5 },
                { propertyId: 999999, graceDays: 5, firstAmount: 5 },
                { propertyId: propertyId + 1000, unitId, graceDays: 5, firstAmount: 5 },
            ]
            for (const body of bad) expect((await admin.post("/api/manager/late-fee-rules", body)).status).toBe(400)
        })
    })

    describe("rent reminders", () => {
        it("saves a rule, records reminders for unpaid rent once a day, and the tenant sees them", async () => {
            const res = await admin.post("/api/manager/reminder-rules", { daysBefore: 3, repeatAfterDue: true })
            expect(res.status).toBe(201)
            const added = await runAs(SYSTEM, () => t.db.sendRentReminders(today(), config.timeZone))
            expect(added).toBeGreaterThan(0)
            expect(await runAs(SYSTEM, () => t.db.sendRentReminders(today(), config.timeZone))).toBe(0)
            const list = (await admin.get("/api/manager/reminder-rules")).body
            expect(list.rules).toHaveLength(1)
            expect(list.sent.length).toBe(added)
            expect(list.sent[0].unitLabel).toMatch(/^Unit /)
            const notices = (await tenant.get("/api/tenant/summary")).body.notices
            expect(notices.some((n: { id: string }) => n.id.startsWith("n_rem_"))).toBe(true)
        })

        it("sends a 'coming up' reminder days before a lease's next due day", async () => {
            // A lease that started a month before a day `daysBefore` days from now (a day of the month every month has),
            // with a rule for its property: its next rent is due that day.
            const day = today()
            let daysBefore = 1
            while (new Date(Date.parse(`${day}T12:00:00Z`) + daysBefore * 86_400_000).getUTCDate() > 28) daysBefore++
            const ahead = new Date(Date.parse(`${day}T12:00:00Z`) + daysBefore * 86_400_000)
            const start = new Date(Date.UTC(ahead.getUTCFullYear(), ahead.getUTCMonth() - 1, ahead.getUTCDate())).toISOString().slice(0, 10)
            const property = await admin.post("/api/manager/properties", { name: "Reminder Row", address: "1 Test Rd" })
            expect((await admin.post("/api/manager/reminder-rules", { propertyId: property.body.id, daysBefore, repeatAfterDue: false })).status).toBe(201)
            const unit = await admin.post("/api/manager/units", { propertyId: property.body.id, unitNum: "R1" })
            const lease = await admin.post("/api/manager/leases", { unitId: unit.body.id, startDate: start, endDate: null, monthlyRent: 800, tenantIds: [], newTenants: [{ name: "Rae Minder", email: "rae.minder@example.com", phone: "" }] })
            expect(lease.status).toBe(201)
            await runAs(SYSTEM, () => t.db.sendRentReminders(day, config.timeZone))
            const sent = await t.owner.query("SELECT kind, due_date AS d, amount::float AS amount FROM Rent_Reminders_Sent WHERE LeaseID = $1 AND kind = 'upcoming'", [lease.body.id])
            expect(sent.rows).toEqual([{ kind: "upcoming", d: ahead.toISOString().slice(0, 10), amount: 800 }])
        })

        it("replaces and turns off rules, and refuses bad input", async () => {
            expect((await admin.post("/api/manager/reminder-rules", { propertyId, daysBefore: 0, repeatAfterDue: false })).status).toBe(201)
            const rules = (await admin.get("/api/manager/reminder-rules")).body.rules
            expect(rules).toHaveLength(3)
            const mine = rules.find((r: { propertyId: number | null }) => r.propertyId === propertyId)
            expect((await admin.delete(`/api/manager/reminder-rules/${mine.id}`)).status).toBe(200)
            expect((await admin.delete(`/api/manager/reminder-rules/${mine.id}`)).status).toBe(404)
            expect((await admin.post("/api/manager/reminder-rules", { daysBefore: 31, repeatAfterDue: true })).status).toBe(400)
            expect((await admin.post("/api/manager/reminder-rules", { daysBefore: 3 })).status).toBe(400)
            expect((await admin.post("/api/manager/reminder-rules", { daysBefore: 3, repeatAfterDue: true, propertyId: 999999 })).status).toBe(400)
        })
    })

    describe("the team and office notifications", () => {
        it("lists active staff", async () => {
            const staff = (await admin.get("/api/manager/staff")).body.staff
            expect(staff.map((s: { email: string }) => s.email)).toEqual(expect.arrayContaining([ACCOUNTS.admin.email, ACCOUNTS.maintenance.email]))
        })

        it("saves where and about what the office is notified", async () => {
            expect((await admin.get("/api/manager/settings/notifications")).body).toEqual({ notifyEmail: null, newMaintenance: true, tenantMessage: true, reportedPayment: true, lateRent: true })
            const input = { notifyEmail: "office@example.com", newMaintenance: false, tenantMessage: true, reportedPayment: true, lateRent: false }
            expect((await admin.put("/api/manager/settings/notifications", input)).body).toEqual(input)
            expect((await admin.get("/api/manager/settings/notifications")).body).toEqual(input)
            expect((await admin.put("/api/manager/settings/notifications", { ...input, notifyEmail: "not an email" })).status).toBe(400)
            expect((await admin.put("/api/manager/settings/notifications", { ...input, lateRent: "yes" })).status).toBe(400)
        })
    })

    describe("maintenance stages, priority and type", () => {
        it("moves a request through the stages and sets priority, type and a scheduled day", async () => {
            const made = await admin.post("/api/manager/maintenance", { unitId, title: "Porch light out", priority: "low", requestType: "electrical" })
            expect(made.status).toBe(201)
            const id = made.body.id
            for (const status of ["in_review", "scheduled", "in_progress", "resolved"]) {
                expect((await admin.put(`/api/manager/maintenance/${id}`, { status })).status).toBe(200)
            }
            expect((await admin.put(`/api/manager/maintenance/${id}`, { priority: "emergency", requestType: "property", scheduledFor: "2026-12-02" })).status).toBe(200)
            const row = (await admin.get("/api/manager/maintenance")).body.requests.find((r: { id: number }) => r.id === id)
            expect(row).toMatchObject({ status: "resolved", priority: "emergency", requestType: "property", scheduledFor: "2026-12-02", propertyId })
            expect((await admin.put(`/api/manager/maintenance/${id}`, { scheduledFor: null })).status).toBe(200)
            expect((await admin.get("/api/manager/maintenance")).body.requests.find((r: { id: number }) => r.id === id).scheduledFor).toBeNull()
        })

        it("refuses unknown values, an empty change and unknown requests", async () => {
            const id = (await admin.get("/api/manager/maintenance")).body.requests[0].id
            expect((await admin.put(`/api/manager/maintenance/${id}`, { status: "done" })).status).toBe(400)
            expect((await admin.put(`/api/manager/maintenance/${id}`, { priority: "asap" })).status).toBe(400)
            expect((await admin.put(`/api/manager/maintenance/${id}`, { requestType: "roof" })).status).toBe(400)
            expect((await admin.put(`/api/manager/maintenance/${id}`, {})).status).toBe(400)
            expect((await admin.put("/api/manager/maintenance/999999", { status: "in_review" })).status).toBe(404)
            expect((await admin.post("/api/manager/maintenance", { unitId, title: "x", priority: "urgent" })).status).toBe(400)
        })

        it("maintenance staff can stage requests too", async () => {
            const id = (await maint.get("/api/manager/maintenance")).body.requests[0].id
            expect((await maint.put(`/api/manager/maintenance/${id}`, { status: "scheduled", scheduledFor: "2026-12-10" })).status).toBe(200)
        })

        it("a tenant's form fills the type and priority, and the tenant sees the stage in their words", async () => {
            const made = await tenant.post("/api/tenant/maintenance", { title: "Sink drips", description: "Category: plumbing | Urgency: urgent | Under the sink" })
            expect(made.status).toBe(201)
            const id = Number(String(made.body.id).replace("mr_", ""))
            const row = (await admin.get("/api/manager/maintenance")).body.requests.find((r: { id: number }) => r.id === id)
            expect(row).toMatchObject({ requestType: "plumbing", priority: "high", status: "submitted" })
            await admin.put(`/api/manager/maintenance/${id}`, { status: "in_review" })
            const seen = () => tenant.get("/api/tenant/summary").then((r) => r.body.maintenanceRequests.find((m: { id: string }) => m.id === `mr_${id}`).status)
            expect(await seen()).toBe("open")
            await admin.put(`/api/manager/maintenance/${id}`, { status: "scheduled" })
            expect(await seen()).toBe("in_progress")
        })
    })

    describe("who may use it", () => {
        it("tenants and maintenance staff get 403 on the office's management screens", async () => {
            for (const who of [tenant, maint]) {
                for (const path of ["/api/manager/charges", `/api/manager/units/${unitId}`, "/api/manager/documents", "/api/manager/late-fee-rules", "/api/manager/reminder-rules", "/api/manager/staff", "/api/manager/settings/notifications"]) {
                    expect((await who.get(path)).status).toBe(403)
                }
                expect((await who.post("/api/manager/late-fee-rules", { graceDays: 5, firstAmount: 5 })).status).toBe(403)
                expect((await who.post(`/api/manager/leases/${leaseId}/charges`, { kind: "hoa", amount: 5, dueDate: "2026-12-01" })).status).toBe(403)
            }
        })

        it("a tenant cannot open another tenant's lease document", async () => {
            const other = await createTenant(admin, host, config.webOrigin, "Other Renter")
            expect((await other.get("/api/tenant/lease-document")).status).toBe(404)
        })
    })

    describe("the nightly run", () => {
        it("runs the late fee and reminder jobs after billing rent", async () => {
            const result = await container.operations.runDailyJobs()
            expect(result).toEqual({ lateFees: expect.any(Number), reminders: expect.any(Number) })
            await expect(container.rentCharges.run()).resolves.toBeGreaterThanOrEqual(0)
        })
    })
})
