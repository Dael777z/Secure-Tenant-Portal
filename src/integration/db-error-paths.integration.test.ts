// Database error translation: when Postgres refuses a write (check, foreign key,
// row-level security), the database layer must turn it into the app's own error
// instead of leaking a raw driver error. Skipped unless TEST_DATABASE_URL is set.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runAs, type Identity } from "../db/identity"
import { seed } from "../db/seed"
import { newInvite } from "../utils/tokens"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const TODAY = new Date("2026-10-16T18:00:00Z")
const TODAY_TEXT = "2026-10-16"
const admin: Identity = { type: "admin", id: 1, role: "admin" }

describe.skipIf(!hasDatabase)("database error translation", () => {
    let t: TestDatabase
    let tenantTid: number
    let leaseId: number
    let unit102: number
    let unit101: number
    let otherTid: number

    const asAdmin = <T>(work: () => Promise<T>) => runAs(admin, work)
    const asTenant = <T>(id: number, work: () => Promise<T>) => runAs({ type: "tenant", id }, work)

    beforeAll(async () => {
        t = await freshDatabase("it_db_errors")
        await seed(t.owner, { dataset: "clean", webOrigin: "http://localhost:5173", bcryptRounds: 4, today: TODAY })
        tenantTid = (await t.owner.query("SELECT tID FROM Tenants WHERE Email = 'tenant@example.com'")).rows[0].tid
        leaseId = (await t.owner.query("SELECT LeaseID FROM Lease LIMIT 1")).rows[0].leaseid
        unit102 = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '102'")).rows[0].uid
        unit101 = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '101'")).rows[0].uid
        await asAdmin(() => t.db.inviteTenant({ name: "Second Person", email: "second@example.com", invite: newInvite().hash }))
        otherTid = (await t.owner.query("SELECT tID FROM Tenants WHERE Email = 'second@example.com'")).rows[0].tid
    })
    afterAll(async () => { await t?.drop() })

    it("an expense with a bad amount or an unknown property is a validation error", async () => {
        const base = { propertyId: null, unitId: null, category: "repairs" as any, amount: 10, spentOn: TODAY_TEXT, vendor: null, description: null }
        await expect(asAdmin(() => t.db.addExpense({ ...base, amount: -5 }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        await expect(asAdmin(() => t.db.addExpense({ ...base, propertyId: 987654 }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
    })

    it("a tenant cannot write into another tenant's conversation, nor file for a unit they do not lease", async () => {
        await expect(asTenant(tenantTid, () => t.db.sendMessage({ tenantId: otherTid, adminId: null, body: "hi" }))).rejects.toMatchObject({ code: "FORBIDDEN" })
        await expect(asTenant(otherTid, () => t.db.createMaintenance({ unitId: unit101, tenantId: otherTid, title: "Leak", description: "x" }))).rejects.toMatchObject({ code: "NOT_FOUND" })   // cannot even see the unit
        await expect(asTenant(tenantTid, () => t.db.createMaintenance({ unitId: unit101, tenantId: otherTid, title: "Leak", description: "x" }))).rejects.toMatchObject({ code: "FORBIDDEN" })   // sees it, but cannot file as someone else
    })

    it("a lease that ends before it starts, or with a bad rent, is a validation error", async () => {
        await expect(asAdmin(() => t.db.createLease({ unitId: unit102, startDate: "2027-05-01", endDate: "2027-01-01", monthlyRent: 900, tenantIds: [tenantTid], newTenants: [] }, TODAY_TEXT)))
            .rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        await expect(asAdmin(() => t.db.createLease({ unitId: unit102, startDate: "2027-01-01", endDate: null, monthlyRent: -1, tenantIds: [tenantTid], newTenants: [] }, TODAY_TEXT)))
            .rejects.toMatchObject({ code: "VALIDATION_ERROR" })
    })

    it("a new tenant with a malformed email is a validation error; a duplicate is EMAIL_IN_USE", async () => {
        await expect(asAdmin(() => t.db.inviteTenant({ name: "Bad", email: "not-an-email", invite: newInvite().hash }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        await expect(asAdmin(() => t.db.inviteTenant({ name: "Dup", email: "second@example.com", invite: newInvite().hash }))).rejects.toMatchObject({ code: "EMAIL_IN_USE" })
    })

    it("adding someone to a lease needs a real person and a real lease", async () => {
        await expect(asAdmin(() => t.db.addTenantToLease(leaseId, {}))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        await expect(asAdmin(() => t.db.addTenantToLease(leaseId, { tenantId: 987654 }))).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(asAdmin(() => t.db.addTenantToLease(987654, { tenantId: tenantTid }))).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("revoking tokens for an unreadable user id does nothing", async () => {
        await expect(t.db.revokeAllTokensForUser("garbage")).resolves.toBeUndefined()
    })
})
