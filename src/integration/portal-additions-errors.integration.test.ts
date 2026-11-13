import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { samplePdf, seed } from "../db/seed"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * The 009 screens' edges over HTTP: what each route refuses (bad input, a
 * record that is not there, a step that is not allowed any more) and the
 * filters and options the happy-path tests in portal-additions don't use.
 */
const config = loadConfig({ NODE_ENV: "test" })
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PDF = samplePdf("Lease addendum").toString("base64")
const MISSING = 999_999

describe.skipIf(!hasDatabase)("009 edges: validation, missing records and filters", () => {
    let t: TestDatabase
    let container: Container
    let close: () => Promise<void>
    let admin: Client
    let tenant: Client
    let maint: Client
    let anonymous: Client

    beforeAll(async () => {
        t = await freshDatabase("it_portal_additions_edges")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4, rules: true })
        container = createContainer({ config, db: t.db, plaid: null })
        let host: string
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

    const status = async (res: Promise<{ status: number; body: any }>) => {
        const r = await res
        return r.body?.error ?? r.status
    }

    describe("Team", () => {
        it("checks the role, and refuses an email a teammate has", async () => {
            expect(await status(admin.post("/api/manager/team", { name: "X", email: "x@example.com", role: "owner" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.post("/api/manager/team", { name: "X", email: ACCOUNTS.maintenance.email, role: "admin" }))).toBe("EMAIL_IN_USE")
            expect(await status(admin.put("/api/manager/team/2", { role: 5 }))).toBe("VALIDATION_ERROR")
        })

        it("a teammate not there is NOT_FOUND", async () => {
            expect(await status(admin.put(`/api/manager/team/${MISSING}`, { name: "Y" }))).toBe("NOT_FOUND")
            expect(await status(admin.delete(`/api/manager/team/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/team/${MISSING}/invite`))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/team/${MISSING}/reset`))).toBe("NOT_FOUND")
        })

        it("a new link for someone still invited; no reset until they have signed up", async () => {
            const invite = await admin.post("/api/manager/team", { name: "Jo Park", email: "jo.park@example.com", role: "maintenance_staff" })
            const again = await admin.post(`/api/manager/team/${invite.body.id}/invite`)
            expect(again.status).toBe(200)
            expect(again.body.inviteLink).not.toBe(invite.body.inviteLink)
            expect(await status(admin.post(`/api/manager/team/${invite.body.id}/reset`))).toBe("STAFF_NOT_SIGNED_UP")
            expect(await status(anonymous.post("/api/auth/signup", { token: new URL(invite.body.inviteLink).searchParams.get("token"), password: "a fine password" }))).toBe("SIGNUP_NOT_ALLOWED")
            expect((await admin.put(`/api/manager/team/${invite.body.id}`, { name: "Jo Park-Lee", role: "admin" })).status).toBe(200)
            const jo = (await admin.get("/api/manager/team")).body.team.find((m: any) => m.id === invite.body.id)
            expect(jo).toMatchObject({ name: "Jo Park-Lee", role: "admin", status: "invited" })
            expect((await admin.delete(`/api/manager/team/${invite.body.id}`)).status).toBe(200)
            expect(await status(admin.put(`/api/manager/team/${invite.body.id}`, { name: "Gone" }))).toBe("NOT_FOUND")
        })
    })

    describe("Activity", () => {
        it("checks each filter", async () => {
            for (const q of ["kind=other", "table=Bad-Table", "since=yesterday", "limit=0", "limit=1001", "limit=two"]) {
                expect(await status(admin.get(`/api/manager/activity?${q}`)), q).toBe("VALIDATION_ERROR")
            }
            expect(await status(admin.get("/api/manager/activity.csv?limit=5001"))).toBe("VALIDATION_ERROR")
        })

        it("filters to sign-ins, or to changes since a time", async () => {
            const sec = (await admin.get("/api/manager/activity?kind=security&limit=20")).body.entries
            expect(sec.length).toBeGreaterThan(0)
            expect(sec.every((e: any) => e.kind === "security")).toBe(true)
            const later = (await admin.get(`/api/manager/activity?kind=&since=${encodeURIComponent("2999-01-01T00:00:00Z")}`)).body.entries
            expect(later).toEqual([])
            expect((await admin.get("/api/manager/activity?table=lease&limit=5")).body.entries.every((e: any) => e.table === "lease")).toBe(true)
        })
    })

    describe("Portfolios and details", () => {
        it("renames, refuses a taken name, and NOT_FOUND for one not there", async () => {
            const made = await admin.post("/api/manager/portfolios", { name: "Valley group", entityName: "Valley LLC", notes: "Two buildings" })
            expect((await admin.put(`/api/manager/portfolios/${made.body.id}`, { name: "Valley holdings", entityName: null, notes: null })).body.id).toBe(made.body.id)
            expect(await status(admin.put(`/api/manager/portfolios/${made.body.id}`, { name: "Woodcrest Holdings" }))).toBe("NAME_IN_USE")
            expect(await status(admin.put(`/api/manager/portfolios/${MISSING}`, { name: "Nope" }))).toBe("NOT_FOUND")
            expect(await status(admin.delete(`/api/manager/portfolios/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(admin.post("/api/manager/portfolios", {}))).toBe("VALIDATION_ERROR")
            expect((await admin.delete(`/api/manager/portfolios/${made.body.id}`)).status).toBe(200)
            expect(await status(admin.delete(`/api/manager/portfolios/${made.body.id}`))).toBe("NOT_FOUND")
        })

        it("checks a property's state, zip and portfolio", async () => {
            const base = { portfolioId: null, city: "Las Cruces", state: "NM", zip: "88001", timeZone: null, notes: "Gate code at the office" }
            expect((await admin.put("/api/manager/properties/1/details", { ...base, zip: "88001-1234" })).status).toBe(200)
            expect(await status(admin.put("/api/manager/properties/1/details", { ...base, state: "N1" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put("/api/manager/properties/1/details", { ...base, zip: "8800" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put("/api/manager/properties/1/details", { ...base, portfolioId: MISSING }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put(`/api/manager/properties/${MISSING}/details`, base))).toBe("NOT_FOUND")
            expect(await status(admin.get(`/api/manager/properties/${MISSING}/details`))).toBe("NOT_FOUND")
            expect((await admin.get("/api/manager/properties/1/details")).body).toMatchObject({ zip: "88001-1234", notes: "Gate code at the office", portfolioId: null })
        })

        it("checks a tenant's insurance and emergency phone", async () => {
            const base = { insuranceStatus: "on_file", insuranceExpires: "2027-06-30", emergencyContactName: null, emergencyContactPhone: null, notes: null }
            expect((await admin.put("/api/manager/tenants/1/details", base)).status).toBe(200)
            expect((await admin.get("/api/manager/tenants/1/details")).body).toMatchObject({ insuranceStatus: "on_file", insuranceExpires: "2027-06-30" })
            expect(await status(admin.put("/api/manager/tenants/1/details", { ...base, emergencyContactPhone: "call me" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put("/api/manager/tenants/1/details", { ...base, insuranceExpires: "June" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put(`/api/manager/tenants/${MISSING}/details`, base))).toBe("NOT_FOUND")
            expect(await status(admin.get(`/api/manager/tenants/${MISSING}/details`))).toBe("NOT_FOUND")
            expect(await status(maint.put("/api/manager/tenants/1/details", base))).toBe("FORBIDDEN")
        })
    })

    describe("Compliance", () => {
        const good = {
            state: " co ", securityDepositMaxMonths: 1.5, depositInterestRequired: true, lateFeeGraceDays: 5, lateFeeMaxPercent: 10,
            noticeToQuitDays: 3, rentIncreaseNoticeDays: 60, leadPaintDisclosureRequired: false, notes: "Checked with counsel", references: "C.R.S. 38-12",
        }

        it("saves every field without confirming", async () => {
            expect((await admin.put("/api/manager/compliance", good)).status).toBe(200)
            expect((await admin.get("/api/manager/compliance")).body).toMatchObject({ state: "CO", securityDepositMaxMonths: 1.5, depositInterestRequired: true, confirmedBy: null, updatedBy: "Dana Whitfield" })
        })

        it("refuses values out of range", async () => {
            for (const bad of [{ state: 5 }, { state: "Colorado" }, { securityDepositMaxMonths: 0.15 }, { securityDepositMaxMonths: 13 }, { securityDepositMaxMonths: "2" },
                { depositInterestRequired: "yes" }, { lateFeeGraceDays: 1.5 }, { lateFeeMaxPercent: 101 }, { noticeToQuitDays: -1 }]) {
                expect(await status(admin.put("/api/manager/compliance", { ...good, ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR")
            }
        })

        it("clears limits with null or an empty value", async () => {
            expect((await admin.put("/api/manager/compliance", { state: "NM", securityDepositMaxMonths: null, lateFeeGraceDays: "", lateFeeMaxPercent: undefined })).status).toBe(200)
            expect((await admin.get("/api/manager/compliance")).body).toMatchObject({ securityDepositMaxMonths: null, lateFeeGraceDays: null, lateFeeMaxPercent: null })
            expect((await admin.get("/api/manager/compliance/warnings")).body.warnings).toEqual([])
        })

        it("warns about deposits above the office's limit", async () => {
            await t.owner.query(`INSERT INTO Charge (LeaseID, kind, amount, due_date, description)
                SELECT LeaseID, 'deposit', monthly_rent * 3, start_date, 'Deposit' FROM Lease WHERE start_date <= current_date AND (end_date IS NULL OR end_date >= current_date) ORDER BY LeaseID LIMIT 1`)
            await admin.put("/api/manager/compliance", { state: "NM", securityDepositMaxMonths: 1 })
            const codes = (await admin.get("/api/manager/compliance/warnings")).body.warnings.map((w: any) => w.code)
            expect(codes).toContain("deposit_above_max")
        })
    })

    describe("Reports and search", () => {
        it("checks the report name and year; takes a date range", async () => {
            expect(await status(admin.get("/api/manager/export/rent-roll"))).toBe("NOT_FOUND")
            expect(await status(admin.get("/api/manager/export/income-by-property.csv?year=1999"))).toBe("VALIDATION_ERROR")
            expect(await status(admin.get("/api/manager/export/income-by-property.csv?year=20x5"))).toBe("VALIDATION_ERROR")
            const income = await admin.get("/api/manager/export/income-by-property.csv?year=2026")
            expect(income.headers.get("content-disposition")).toContain("income-by-property-2026.csv")
            const range = await admin.get("/api/manager/export/maintenance.csv?from=2020-01-01&to=2030-12-31")
            expect(range.bytes.toString("utf8").split("\r\n").length).toBeGreaterThan(3)
            expect(await status(admin.get("/api/manager/export/payments.csv?from=soon"))).toBe("VALIDATION_ERROR")
            expect(await status(maint.get("/api/manager/reports"))).toBe("FORBIDDEN")
        })

        it("search: residents can't; an empty box finds nothing; finds units, buildings, requests, listings, documents and payments", async () => {
            expect(await status(tenant.get("/api/manager/search?q=wood"))).toBe("FORBIDDEN")
            expect((await admin.get("/api/manager/search")).body.hits).toEqual([])
            const kinds = async (q: string) => new Set((await admin.get(`/api/manager/search?q=${encodeURIComponent(q)}`)).body.hits.map((h: any) => h.kind))
            expect(await kinds("Woodcrest")).toEqual(expect.objectContaining({}))
            const wood = await kinds("Woodcrest")
            for (const k of ["unit", "property", "portfolio"]) expect(wood.has(k), k).toBe(true)
            expect((await kinds("balcony")).has("listing")).toBe(true)
            expect((await kinds("faucet")).has("maintenance")).toBe(true)
            const confirmation = (await t.owner.query("SELECT transaction_id FROM Payment WHERE transaction_id IS NOT NULL LIMIT 1")).rows[0].transaction_id
            expect((await kinds(confirmation)).has("payment")).toBe(true)
            await admin.post("/api/manager/documents", { scope: "unit", id: 1, category: "inspection", title: "Smoke detector check", sharedWithTenant: false, filename: "smoke.pdf", data: PDF })
            expect((await kinds("smoke detector")).has("document")).toBe(true)
            expect((await admin.get("/api/manager/search?q=100%25_off")).body.hits).toEqual([])
        })
    })

    describe("Maintenance detail", () => {
        let faucet: number
        beforeAll(async () => {
            faucet = (await admin.get("/api/manager/maintenance")).body.requests.find((r: any) => r.title === "Kitchen faucet leaking").id
        })

        it("checks the summary window, and NOT_FOUND for a request or photo not there", async () => {
            for (const days of ["0", "3651", "x"]) expect(await status(admin.get(`/api/manager/maintenance/summary?days=${days}`))).toBe("VALIDATION_ERROR")
            expect((await admin.get("/api/manager/maintenance/summary")).body.days).toBe(30)
            expect(await status(admin.get(`/api/manager/maintenance/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(admin.get(`/api/manager/maintenance/${faucet}/attachments/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/maintenance/${MISSING}/notes`, { body: "x" }))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/maintenance/${MISSING}/attachments`, { filename: "a.png", data: PNG }))).toBe("NOT_FOUND")
            expect(await status(admin.put(`/api/manager/maintenance/${MISSING}/work`, { laborCost: 5 }))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/maintenance/${MISSING}/expense`))).toBe("NOT_FOUND")
        })

        it("checks costs and who it is assigned to; nothing to change is fine", async () => {
            for (const laborCost of [-1, 1.234, "12", 100_001]) {
                expect(await status(admin.put(`/api/manager/maintenance/${faucet}/work`, { laborCost })), String(laborCost)).toBe("VALIDATION_ERROR")
            }
            expect(await status(admin.put(`/api/manager/maintenance/${faucet}/work`, { assignedTo: MISSING }))).toBe("VALIDATION_ERROR")
            expect((await admin.put(`/api/manager/maintenance/${faucet}/work`, {})).status).toBe(200)
            expect((await admin.put(`/api/manager/maintenance/${faucet}/work`, { assignedTo: null, laborCost: null, materialsCost: "" })).status).toBe(200)
            expect((await admin.get(`/api/manager/maintenance/${faucet}`)).body).toMatchObject({ assignedTo: null, laborCost: null, materialsCost: null })
            expect(await status(admin.post(`/api/manager/maintenance/${faucet}/expense`))).toBe("VALIDATION_ERROR")      // no cost to book
            expect(await status(admin.post(`/api/manager/maintenance/${faucet}/notes`, { body: "" }))).toBe("VALIDATION_ERROR")
        })

        it("a resident lists only well-formed ids, and can't add photos as staff", async () => {
            expect((await tenant.get("/api/tenant/maintenance/attachments")).body.attachments).toEqual({})
            expect(await status(tenant.get("/api/tenant/maintenance/attachments?ids=1,abc"))).toBe("VALIDATION_ERROR")
            expect(await status(tenant.post(`/api/manager/maintenance/${faucet}/attachments`, { filename: "a.png", data: PNG }))).toBe("FORBIDDEN")
            expect(await status(tenant.get(`/api/tenant/maintenance/${faucet}/attachments/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(maint.post(`/api/tenant/maintenance/${faucet}/attachments`, { filename: "a.png", data: PNG }))).toBe("FORBIDDEN")
        })
    })

    describe("Notices", () => {
        it("filters the log, and checks each filter", async () => {
            await admin.post("/api/manager/notices", { audience: { kind: "all" }, subject: "Pool closed", body: "Through Sunday." })
            const found = (await admin.get("/api/manager/notices?template=manual&channel=in_app&status=sent&q=pool")).body
            expect(found.emailEnabled).toBe(false)
            expect(found.notices.length).toBeGreaterThan(0)
            expect(found.notices.every((n: any) => n.subject === "Pool closed")).toBe(true)
            for (const q of ["template=spam", "channel=fax", "status=lost"]) expect(await status(admin.get(`/api/manager/notices?${q}`)), q).toBe("VALIDATION_ERROR")
        })

        it("checks the audience; a resident can only mark their own notice read", async () => {
            expect(await status(admin.post("/api/manager/notices", { audience: { kind: "everyone" }, subject: "x", body: "y" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.post("/api/manager/notices", { subject: "x", body: "y" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.post("/api/manager/notices", { audience: { kind: "property", id: "one" }, subject: "x", body: "y" }))).toBe("VALIDATION_ERROR")
            const tenantId = (await tenant.get("/api/tenant/summary")).body
            expect(tenantId).toBeTruthy()
            const sent = await admin.post("/api/manager/notices", { audience: { kind: "tenant", id: 2 }, subject: "Just for 2", body: "." })
            expect(sent.body.recipients).toBe(1)
            const other = (await t.owner.query("SELECT notID FROM Notifications_Sent WHERE subject = 'Just for 2'")).rows[0].notid
            const mine = (await tenant.get("/api/tenant/notices")).body.notices.map((n: any) => n.id)
            if (!mine.includes(other)) expect(await status(tenant.post(`/api/tenant/notices/${other}/read`))).toBe("NOT_FOUND")
            expect(await status(tenant.post(`/api/tenant/notices/${MISSING}/read`))).toBe("NOT_FOUND")
        })
    })

    describe("Documents", () => {
        const upload = (over: Record<string, unknown>) =>
            admin.post("/api/manager/documents", { scope: "unit", id: 1, category: "other", title: "Doc", sharedWithTenant: false, filename: "d.pdf", data: PDF, ...over })

        it("files against a property, unit, tenant or lease, and finds them by scope, category or words", async () => {
            const ids: Record<string, number> = {}
            for (const scope of ["property", "unit", "lease"]) {
                const res = await upload({ scope, title: `For the ${scope}`, category: scope === "lease" ? "lease" : "insurance" })
                expect(res.status, scope).toBe(201)
                ids[scope] = res.body.id
            }
            expect((await upload({ category: undefined, title: "No category" })).status).toBe(201)
            for (const scope of ["property", "unit", "lease"]) {
                const docs = (await admin.get(`/api/manager/documents/all?scope=${scope}&id=1`)).body.documents
                expect(docs.map((d: any) => d.id), scope).toContain(ids[scope])
            }
            const insurance = (await admin.get("/api/manager/documents/all?category=insurance")).body.documents
            expect(insurance.every((d: any) => d.category === "insurance")).toBe(true)
            expect((await admin.get("/api/manager/documents/all?q=for%20the%20lease")).body.documents.map((d: any) => d.title)).toEqual(["For the lease"])
            expect((await admin.get("/api/manager/documents/all")).body.documents.length).toBeGreaterThan(4)
            const file = await admin.get(`/api/manager/documents/${ids.unit}`)
            expect(file.headers.get("content-type")).toBe("application/pdf")
        })

        it("checks the scope, sharing flag and file; NOT_FOUND for a record not there", async () => {
            expect(await status(upload({ scope: "building" }))).toBe("VALIDATION_ERROR")
            expect(await status(upload({ scope: undefined }))).toBe("VALIDATION_ERROR")
            expect(await status(upload({ sharedWithTenant: "yes" }))).toBe("VALIDATION_ERROR")
            expect(await status(upload({ category: "receipt-ish" }))).toBe("VALIDATION_ERROR")
            expect(await status(upload({ id: MISSING }))).toBe("NOT_FOUND")
            expect(await status(upload({ scope: "tenant", id: MISSING }))).toBe("NOT_FOUND")
            expect(await status(upload({ data: "not base64!" }))).toBe("FILE_INVALID")
            expect(await status(admin.get("/api/manager/documents/all?scope=unit&id=x"))).toBe("VALIDATION_ERROR")
            expect(await status(admin.get("/api/manager/documents/all?category=junk"))).toBe("VALIDATION_ERROR")
            expect(await status(admin.get(`/api/manager/documents/${MISSING}`))).toBe("NOT_FOUND")
            expect(await status(maint.post("/api/manager/documents", { scope: "unit", id: 1, title: "x", sharedWithTenant: false, data: PDF }))).toBe("FORBIDDEN")
        })

        it("renames, re-files and shares; then hidden is gone", async () => {
            const made = await upload({ title: "Draft" })
            const id = made.body.id
            expect((await admin.put(`/api/manager/documents/${id}`, { title: "Final", category: "notice", sharedWithTenant: true })).status).toBe(200)
            expect((await admin.put(`/api/manager/documents/${id}`, {})).status).toBe(200)
            const doc = (await admin.get("/api/manager/documents/all?q=Final")).body.documents.find((d: any) => d.id === id)
            expect(doc).toMatchObject({ title: "Final", category: "notice", sharedWithTenant: true })
            expect(await status(admin.put(`/api/manager/documents/${id}`, { sharedWithTenant: "no" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put(`/api/manager/documents/${id}`, { category: "junk" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put(`/api/manager/documents/${MISSING}`, { title: "x" }))).toBe("NOT_FOUND")
            expect((await admin.delete(`/api/manager/documents/${id}`)).status).toBe(200)
            expect(await status(admin.delete(`/api/manager/documents/${id}`))).toBe("NOT_FOUND")
            expect(await status(admin.put(`/api/manager/documents/${id}`, { title: "Back" }))).toBe("NOT_FOUND")
        })
    })

    describe("Listings and leads", () => {
        let unitId: number
        let listingId: number
        beforeAll(async () => {
            const units = (await admin.get("/api/manager/units")).body.units.filter((u: any) => u.status === "vacant")
            const listed = new Set((await admin.get("/api/manager/listings")).body.listings.map((l: any) => l.unitId))
            unitId = units.find((u: any) => !listed.has(u.id)).id
        })

        it("checks each listing field", async () => {
            const base = { unitId, title: "Garden studio", askingRent: 850 }
            for (const bad of [{ amenities: "pool" }, { amenities: ["x".repeat(61)] }, { amenities: [" "] }, { amenities: Array(41).fill("a") },
                { sqft: -1 }, { sqft: 1.5 }, { sqft: "600" }, { beds: "2" }, { baths: 21 }, { beds: -0.5 }, { title: "" }, { askingRent: -5 }, { availableOn: "soon" }]) {
                expect(await status(admin.post("/api/manager/listings", { ...base, ...bad })), JSON.stringify(bad).slice(0, 40)).toBe("VALIDATION_ERROR")
            }
            expect(await status(admin.post("/api/manager/listings", { ...base, unitId: MISSING }))).toBe("NOT_FOUND")
        })

        it("drafts with every field, edits, publishes once, and ends", async () => {
            const made = await admin.post("/api/manager/listings", {
                unitId, title: "Garden studio", description: "Quiet, near the park.", askingRent: 850, availableOn: "2026-12-01",
                beds: 0, baths: 1.5, sqft: 480, amenities: [" Patio ", "Laundry"], pets: "Cats OK",
            })
            expect(made.status).toBe(201)
            listingId = made.body.id
            expect((await admin.get(`/api/manager/listings/${listingId}`)).body).toMatchObject({ status: "draft", amenities: ["Patio", "Laundry"], baths: 1.5, sqft: 480, pets: "Cats OK", leadList: [] })
            expect((await admin.put(`/api/manager/listings/${listingId}`, { title: "Garden studio, renovated", askingRent: 875, beds: null, sqft: "" })).status).toBe(200)
            expect((await admin.post(`/api/manager/listings/${listingId}/publish`)).status).toBe(200)
            expect(await status(admin.post(`/api/manager/listings/${listingId}/publish`))).toBe("LISTING_NOT_EDITABLE")
            const pub = (await anonymous.get("/api/public/listings")).body.listings.find((l: any) => l.id === listingId)
            expect(pub).toMatchObject({ title: "Garden studio, renovated", askingRent: 875 })
            expect(await status(anonymous.get(`/api/public/listings/${listingId}/photos/${MISSING}`))).toBe("NOT_FOUND")
            for (const photoId of pub.photoIds ?? []) {
                const photo = await anonymous.get(`/api/public/listings/${listingId}/photos/${photoId}`)
                expect(photo.status).toBe(200)
                expect(photo.headers.get("cache-control")).toContain("public")
            }
        })

        it("leads: checks contact details; NOT_FOUND for a listing or lead not there", async () => {
            for (const bad of [{ email: "nope" }, { phone: "abc" }, {}, { name: "", email: "a@b.co" }]) {
                expect(await status(admin.post(`/api/manager/listings/${listingId}/leads`, { name: "Walk-in", ...bad })), JSON.stringify(bad)).toBe("VALIDATION_ERROR")
                expect(await status(anonymous.post(`/api/public/listings/${listingId}/inquire`, { name: "Web", ...bad }))).toBe("VALIDATION_ERROR")
            }
            const lead = await admin.post(`/api/manager/listings/${listingId}/leads`, { name: "Walk-in", phone: "(575) 555-0142", message: "Saw the sign" })
            expect(lead.status).toBe(201)
            expect((await admin.put(`/api/manager/leads/${lead.body.id}`, { status: "contacted" })).status).toBe(200)
            expect((await admin.get("/api/manager/leads")).body.leads.find((l: any) => l.id === lead.body.id)).toMatchObject({ status: "contacted", source: "manual" })
            expect(await status(admin.put(`/api/manager/leads/${lead.body.id}`, { status: "won" }))).toBe("VALIDATION_ERROR")
            expect(await status(admin.put(`/api/manager/leads/${MISSING}`, { status: "closed" }))).toBe("NOT_FOUND")
            expect(await status(admin.post(`/api/manager/listings/${MISSING}/leads`, { name: "X", email: "x@example.com" }))).toBe("NOT_FOUND")
            expect(await status(anonymous.post(`/api/public/listings/${MISSING}/inquire`, { name: "X", email: "x@example.com" }))).toBe("NOT_FOUND")
            expect((await anonymous.post(`/api/public/listings/${listingId}/inquire`, { name: "Web", phone: "575-555-0100" })).status).toBe(201)
        })

        it("an ended listing can't be edited, published, ended again or removed; missing ones are NOT_FOUND", async () => {
            expect((await admin.post(`/api/manager/listings/${listingId}/end`)).status).toBe(200)
            expect(await status(admin.put(`/api/manager/listings/${listingId}`, { title: "x", askingRent: 1 }))).toBe("LISTING_NOT_EDITABLE")
            expect(await status(admin.post(`/api/manager/listings/${listingId}/publish`))).toBe("LISTING_NOT_EDITABLE")
            expect(await status(admin.post(`/api/manager/listings/${listingId}/end`))).toBe("LISTING_NOT_EDITABLE")
            expect(await status(admin.delete(`/api/manager/listings/${listingId}`))).toBe("LISTING_NOT_EDITABLE")
            for (const call of [admin.get(`/api/manager/listings/${MISSING}`), admin.put(`/api/manager/listings/${MISSING}`, { title: "x", askingRent: 1 }),
                admin.post(`/api/manager/listings/${MISSING}/publish`), admin.post(`/api/manager/listings/${MISSING}/end`), admin.delete(`/api/manager/listings/${MISSING}`)]) {
                expect(await status(call)).toBe("NOT_FOUND")
            }
            expect(await status(maint.post("/api/manager/listings", { unitId, title: "x", askingRent: 1 }))).toBe("FORBIDDEN")
            const drafted = await admin.post("/api/manager/listings", { unitId, title: "Relisted", askingRent: 900 })
            expect(drafted.status).toBe(201)          // ended ones don't block a new listing for the unit
        })
    })
})
