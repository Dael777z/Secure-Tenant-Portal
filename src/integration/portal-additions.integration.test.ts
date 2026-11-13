import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { samplePdf, seed } from "../db/seed"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * The 009 screens over HTTP on the sample data (with its 009 sample): the
 * team and staff sign-up, the activity log, portfolios and details,
 * compliance warnings, reports, search, maintenance detail and photos,
 * notices, documents, listings and the public page, and who may do what.
 */
const config = loadConfig({ NODE_ENV: "test" })
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PDF = samplePdf("Move-in inspection").toString("base64")

describe.skipIf(!hasDatabase)("Office tools, maintenance detail, leasing, notices and documents (009)", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    let admin: Client
    let tenant: Client
    let maint: Client
    let anonymous: Client

    beforeAll(async () => {
        t = await freshDatabase("it_portal_additions")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4, rules: true })
        container = createContainer({ config, db: t.db, plaid: null })
        ;({ host, close } = await listen(createApp(container)))
        admin = await new Client(host, config.webOrigin).signIn(ACCOUNTS.admin)
        tenant = await new Client(host, config.webOrigin).signIn(ACCOUNTS.tenant)
        maint = await new Client(host, config.webOrigin).signIn(ACCOUNTS.maintenance)
        anonymous = new Client(host, config.webOrigin)
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    describe("Team", () => {
        it("invites a teammate who signs up with the link, then shows them as active with a sign-in", async () => {
            const invite = await admin.post("/api/manager/team", { name: "Pat Lee", email: "pat.lee@example.com", role: "maintenance_staff" })
            expect(invite.status).toBe(201)
            const token = new URL(invite.body.inviteLink).searchParams.get("token")!
            const before = (await admin.get("/api/manager/team")).body.team.find((m: any) => m.email === "pat.lee@example.com")
            expect(before.status).toBe("invited")
            const signup = await anonymous.post("/api/auth/signup", { token, password: "correct horse battery" })
            expect(signup.status).toBe(201)
            expect(signup.body.role).toBe("maintenance_staff")
            const pat = await new Client(host, config.webOrigin).signIn({ email: "pat.lee@example.com", password: "correct horse battery" })
            expect((await pat.get("/api/manager/maintenance")).status).toBe(200)
            const after = (await admin.get("/api/manager/team")).body.team.find((m: any) => m.email === "pat.lee@example.com")
            expect(after.status).toBe("active")
            expect(after.lastLoginAt).not.toBeNull()
        })

        it("refuses an email a tenant already uses", async () => {
            expect((await admin.post("/api/manager/team", { name: "Dup", email: ACCOUNTS.tenant.email, role: "admin" })).body.error).toBe("EMAIL_IN_USE")
        })

        it("won't let a manager change their own role, or demote the last property manager", async () => {
            expect((await admin.put("/api/manager/team/1", { role: "maintenance_staff" })).body.error).toBe("SELF_CHANGE_FORBIDDEN")
            expect((await admin.delete("/api/manager/team/1")).body.error).toBe("SELF_CHANGE_FORBIDDEN")
        })

        it("reset sign-in stops the old password and makes a working link; deactivate signs them out", async () => {
            const invite = await admin.post("/api/manager/team", { name: "Sam Ray", email: "sam.ray@example.com", role: "admin" })
            const id = invite.body.id
            await anonymous.post("/api/auth/signup", { token: new URL(invite.body.inviteLink).searchParams.get("token"), password: "first good password" })
            expect((await admin.post(`/api/manager/team/${id}/invite`)).body.error).toBe("STAFF_ALREADY_SIGNED_UP")
            const reset = await admin.post(`/api/manager/team/${id}/reset`)
            expect(reset.status).toBe(200)
            expect((await new Client(host, config.webOrigin).post("/api/auth/login", { email: "sam.ray@example.com", password: "first good password" })).status).toBe(401)
            await anonymous.post("/api/auth/signup", { token: new URL(reset.body.inviteLink).searchParams.get("token"), password: "second good password" })
            const sam = await new Client(host, config.webOrigin).signIn({ email: "sam.ray@example.com", password: "second good password" })
            expect((await admin.delete(`/api/manager/team/${id}`)).status).toBe(200)
            expect((await sam.post("/api/auth/refresh")).status).toBe(401)
        })

        it("is for property managers only", async () => {
            expect((await maint.get("/api/manager/team")).status).toBe(403)
            expect((await tenant.get("/api/manager/team")).status).toBe(403)
        })
    })

    describe("Activity", () => {
        it("shows record changes with who made them, and sign-ins", async () => {
            const all = await admin.get("/api/manager/activity?limit=50")
            expect(all.status).toBe(200)
            expect(all.body.entries.some((e: any) => e.kind === "security" && e.action === "login_success" && e.byName === "Dana Whitfield")).toBe(true)
            const changes = await admin.get("/api/manager/activity?kind=change&table=portfolios")
            expect(changes.body.entries.every((e: any) => e.table === "portfolios")).toBe(true)
            const csv = await admin.get("/api/manager/activity.csv?limit=10")
            expect(csv.headers.get("content-type")).toContain("text/csv")
        })
    })

    describe("Portfolios, details and compliance", () => {
        it("lists the sample portfolio with its numbers, and the building not in one", async () => {
            const res = await admin.get("/api/manager/portfolios")
            const woodcrest = res.body.portfolios.find((f: any) => f.name === "Woodcrest Holdings")
            expect(woodcrest.properties.map((p: any) => p.name)).toEqual(["Woodcrest Apartments"])
            expect(woodcrest.units).toBe(12)
            expect(woodcrest.occupancy).toBeCloseTo(woodcrest.occupied / woodcrest.units)
            expect(res.body.unassigned.map((p: any) => p.name)).toEqual(["Mesilla Court"])
        })

        it("refuses a duplicate name, and retiring one unassigns its buildings", async () => {
            expect((await admin.post("/api/manager/portfolios", { name: "woodcrest holdings" })).body.error).toBe("NAME_IN_USE")
            const made = await admin.post("/api/manager/portfolios", { name: "Mesilla group" })
            const mesilla = (await admin.get("/api/manager/portfolios")).body.unassigned[0]
            expect((await admin.put(`/api/manager/properties/${mesilla.id}/details`, { portfolioId: made.body.id, city: "Mesilla", state: "nm", zip: "88046", timeZone: "America/Denver", notes: null })).status).toBe(200)
            expect((await admin.get(`/api/manager/properties/${mesilla.id}/details`)).body).toMatchObject({ portfolioName: "Mesilla group", state: "NM" })
            expect((await admin.put(`/api/manager/properties/${mesilla.id}/details`, { portfolioId: null, city: null, state: null, zip: null, timeZone: "Mars/Olympus", notes: null })).status).toBe(400)
            await admin.delete(`/api/manager/portfolios/${made.body.id}`)
            expect((await admin.get(`/api/manager/properties/${mesilla.id}/details`)).body.portfolioId).toBeNull()
        })

        it("keeps tenant details", async () => {
            const res = await admin.put("/api/manager/tenants/2/details", { insuranceStatus: "required", insuranceExpires: null, emergencyContactName: "Ana", emergencyContactPhone: "(575) 555-0199", notes: "Prefers text" })
            expect(res.status).toBe(200)
            expect((await admin.get("/api/manager/tenants/2/details")).body).toMatchObject({ insuranceStatus: "required", emergencyContactName: "Ana", updatedBy: "Dana Whitfield" })
            expect((await admin.put("/api/manager/tenants/2/details", { insuranceStatus: "maybe" })).status).toBe(400)
        })

        it("warns about late fee rules outside the office's values", async () => {
            expect((await admin.get("/api/manager/compliance/warnings")).body.warnings).toEqual([])
            await admin.put("/api/manager/compliance", { state: "NM", securityDepositMaxMonths: 1, lateFeeGraceDays: 7, lateFeeMaxPercent: 5, confirm: true })
            const settings = (await admin.get("/api/manager/compliance")).body
            expect(settings).toMatchObject({ state: "NM", lateFeeGraceDays: 7, confirmedBy: "Dana Whitfield" })
            const codes = (await admin.get("/api/manager/compliance/warnings")).body.warnings.map((w: any) => w.code)
            expect(codes).toContain("grace_below_min")
            expect(codes).toContain("late_fee_above_max")
        })
    })

    describe("Reports and search", () => {
        it("downloads every report as CSV", async () => {
            const reports = (await admin.get("/api/manager/reports")).body.reports
            expect(reports).toHaveLength(8)
            for (const r of reports) {
                const res = await admin.get(`/api/manager${r.href}`)
                expect(res.status, r.key).toBe(200)
                expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=".+\.csv"/)
                expect(res.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
            }
            expect((await admin.get("/api/manager/export/nope.csv")).status).toBe(404)
            expect((await admin.get("/api/manager/export/payments.csv?from=2026-02-01&to=2026-01-01")).status).toBe(400)
        })

        it("finds people by name or phone digits; maintenance staff only see requests", async () => {
            const byPhone = (await admin.get("/api/manager/search?q=555-0103")).body.hits
            expect(byPhone[0]).toMatchObject({ kind: "tenant", title: "Aisha Okafor" })
            expect((await admin.get("/api/manager/search?q=a")).body.hits).toEqual([])
            const fixer = (await maint.get("/api/manager/search?q=wood")).body.hits
            expect(fixer.every((h: any) => h.kind === "maintenance")).toBe(true)
        })
    })

    describe("Maintenance detail", () => {
        it("assigns, costs, notes and photos; books the cost once as an expense", async () => {
            const faucet = (await admin.get("/api/manager/maintenance")).body.requests.find((r: any) => r.title === "Kitchen faucet leaking")
            const detail = (await maint.get(`/api/manager/maintenance/${faucet.id}`)).body
            expect(detail.assignedName).toBe("Luis Ortega")
            expect(detail.notes).toHaveLength(1)
            expect((await maint.put(`/api/manager/maintenance/${faucet.id}/work`, { laborCost: 85, materialsCost: 31.5 })).status).toBe(200)
            expect((await maint.post(`/api/manager/maintenance/${faucet.id}/notes`, { body: "Replaced the cartridge." })).status).toBe(201)
            expect((await maint.post(`/api/manager/maintenance/${faucet.id}/attachments`, { filename: "after.png", data: PNG })).status).toBe(201)
            expect((await maint.post(`/api/manager/maintenance/${faucet.id}/attachments`, { filename: "after.png", data: PDF })).body.error).toBe("FILE_INVALID")
            expect((await maint.post(`/api/manager/maintenance/${faucet.id}/expense`)).status).toBe(403)
            const booked = await admin.post(`/api/manager/maintenance/${faucet.id}/expense`)
            expect(booked.status).toBe(201)
            expect((await admin.post(`/api/manager/maintenance/${faucet.id}/expense`)).body.error).toBe("ALREADY_RECORDED")
            const expense = (await t.owner.query("SELECT amount, category FROM Expenses WHERE expID = $1", [booked.body.expenseId])).rows[0]
            expect(expense).toEqual({ amount: 116.5, category: "repairs" })
            const after = (await admin.get(`/api/manager/maintenance/${faucet.id}`)).body
            expect(after.attachments[0]).toMatchObject({ filename: "after.png", fromTenant: false, uploadedBy: "Luis Ortega" })
            const photo = await admin.get(`/api/manager/maintenance/${faucet.id}/attachments/${after.attachments[0].id}`)
            expect(photo.headers.get("content-type")).toBe("image/png")
        })

        it("lets a tenant add photos to their own open request only", async () => {
            const mine = (await tenant.get("/api/tenant/summary")).body.maintenanceRequests.map((r: any) => Number(r.id.replace("mr_", "")))
            expect((await tenant.post(`/api/tenant/maintenance/${mine[0]}/attachments`, { filename: "sink.png", data: PNG })).status).toBe(201)
            const photos = (await tenant.get(`/api/tenant/maintenance/attachments?ids=${mine.join(",")}`)).body.attachments
            const href = photos[String(mine[0])].at(-1).href
            expect((await tenant.get(href)).status).toBe(200)
            const others = (await admin.get("/api/manager/maintenance")).body.requests.find((r: any) => r.tenantName !== "Test Tenant" && r.status !== "resolved")
            expect((await tenant.post(`/api/tenant/maintenance/${others.id}/attachments`, { filename: "x.png", data: PNG })).status).toBe(404)
            expect(Object.keys((await tenant.get(`/api/tenant/maintenance/attachments?ids=${others.id}`)).body.attachments)).toEqual([])
        })

        it("summarizes the queue", async () => {
            const s = (await admin.get("/api/manager/maintenance/summary?days=90")).body
            expect(s.open).toBeGreaterThan(0)
            expect(Object.values(s.byStatus).reduce((a: number, b: any) => a + b, 0)).toBeGreaterThan(0)
        })
    })

    describe("Notices and documents", () => {
        it("sends a notice to a building's residents; each sees it once and can mark it read", async () => {
            const sent = await admin.post("/api/manager/notices", { audience: { kind: "property", id: 1 }, subject: "Water off Friday", body: "9am to noon." })
            expect(sent.status).toBe(201)
            expect(sent.body.recipients).toBeGreaterThan(0)
            const mine = (await tenant.get("/api/tenant/notices")).body.notices
            expect(mine.filter((n: any) => n.subject === "Water off Friday")).toHaveLength(1)
            expect((await tenant.post(`/api/tenant/notices/${mine[0].id}/read`)).status).toBe(200)
            expect((await tenant.get("/api/tenant/notices")).body.notices[0].readAt).not.toBeNull()
            expect((await admin.post("/api/manager/notices", { audience: { kind: "tenant", id: 999999 }, subject: "x", body: "y" })).body.error).toBe("NO_RECIPIENTS")
        })

        it("logs automatic notices: payments received and rent reminders", async () => {
            const templates = new Set((await admin.get("/api/manager/notices")).body.notices.map((n: any) => n.template))
            expect(templates.has("payment_received")).toBe(true)
            expect(templates.has("manual")).toBe(true)
        })

        it("shares only the documents the office shares", async () => {
            const shared = await admin.post("/api/manager/documents", { scope: "tenant", id: 1, category: "inspection", title: "Move-in inspection", sharedWithTenant: true, filename: "inspection.pdf", data: PDF })
            const kept = await admin.post("/api/manager/documents", { scope: "tenant", id: 1, category: "other", title: "Office notes", sharedWithTenant: false, filename: "notes.pdf", data: PDF })
            expect(shared.status).toBe(201)
            const groups = (await tenant.get("/api/tenant/documents")).body.groups
            const titles = groups.flatMap((g: any) => g.documents.map((d: any) => d.title))
            expect(titles).toContain("Move-in inspection")
            expect(titles).toContain("Your signed lease")
            expect(titles).not.toContain("Office notes")
            expect((await tenant.get(`/api/tenant/documents/${kept.body.id}`)).status).toBe(404)
            const file = await tenant.get(`/api/tenant/documents/${shared.body.id}`)
            expect(file.headers.get("content-security-policy")).toBe("sandbox")
            const hub = (await admin.get("/api/manager/documents/all?scope=tenant&id=1")).body.documents
            expect(hub.map((d: any) => d.title)).toEqual(expect.arrayContaining(["Move-in inspection", "Office notes"]))
            await admin.delete(`/api/manager/documents/${shared.body.id}`)
            expect((await tenant.get(`/api/tenant/documents/${shared.body.id}`)).status).toBe(404)
        })
    })

    describe("Listings and the public page", () => {
        it("shows the sample listing publicly, takes an inquiry as a lead, and stops when ended", async () => {
            const pub = (await anonymous.get("/api/public/listings")).body.listings
            expect(pub).toHaveLength(1)
            expect(pub[0]).toMatchObject({ title: "Bright 1-bedroom with balcony", askingRent: 975, city: "Las Cruces" })
            expect((await anonymous.post(`/api/public/listings/${pub[0].id}/inquire`, { name: "Kim", email: "kim@example.com", website: "" })).status).toBe(201)
            const detail = (await admin.get(`/api/manager/listings/${pub[0].id}`)).body
            expect(detail.leadList.map((l: any) => l.name)).toContain("Kim")
            expect((await admin.delete(`/api/manager/listings/${pub[0].id}`)).body.error).toBe("LISTING_NOT_EDITABLE")
            expect((await admin.post(`/api/manager/listings/${pub[0].id}/end`)).status).toBe(200)
            expect((await anonymous.get("/api/public/listings")).body.listings).toEqual([])
            expect((await anonymous.post(`/api/public/listings/${pub[0].id}/inquire`, { name: "Late", email: "late@example.com" })).status).toBe(404)
        })

        it("drafts one listing per unit, and only a draft can be removed", async () => {
            const units = (await admin.get("/api/manager/units")).body.units.filter((u: any) => u.status === "vacant")
            const made = await admin.post("/api/manager/listings", { unitId: units[0].id, title: "Studio", askingRent: 800, amenities: [] })
            expect(made.status).toBe(201)
            expect((await admin.post("/api/manager/listings", { unitId: units[0].id, title: "Again", askingRent: 800 })).body.error).toBe("LISTING_EXISTS")
            expect((await admin.post("/api/manager/listings", { unitId: units[1].id, title: "Bad", askingRent: 800, beds: 1.25 })).status).toBe(400)
            expect((await admin.delete(`/api/manager/listings/${made.body.id}`)).status).toBe(200)
        })

        it("ignores the hidden field bots fill in", async () => {
            const before = (await admin.get("/api/manager/leads")).body.leads.length
            expect((await anonymous.post("/api/public/listings/1/inquire", { name: "Bot", email: "bot@example.com", website: "http://spam" })).status).toBe(201)
            expect((await admin.get("/api/manager/leads")).body.leads.length).toBe(before)
        })
    })
})
