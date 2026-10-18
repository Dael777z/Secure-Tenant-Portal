// The database layer against the database dev's real schema (001) plus our
// migrations (002, 003): row-level security, append-only payments, overlap
// checks, invites, reversals. Skipped unless TEST_DATABASE_URL is set.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runAs, type Identity } from "../db/identity"
import { seed } from "../db/seed"
import { hashToken, newInvite } from "../utils/tokens"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const TODAY = new Date("2026-10-16T18:00:00Z")
const TODAY_TEXT = "2026-10-16"
const admin: Identity = { type: "admin", id: 1 }
const invite = newInvite

describe.skipIf(!hasDatabase)("PostgresDatabase on the Summit schema", () => {
    let t: TestDatabase
    let tenantTid: number          // tenant@example.com, on unit 101
    let leaseId: number            // their lease
    let unit102: number

    const asAdmin = <T>(work: () => Promise<T>) => runAs(admin, work)
    const asTenant = <T>(id: number, work: () => Promise<T>) => runAs({ type: "tenant", id }, work)

    beforeAll(async () => {
        t = await freshDatabase("it_db")
        await seed(t.owner, { dataset: "clean", webOrigin: "http://localhost:5173", bcryptRounds: 4, today: TODAY })
        tenantTid = (await t.owner.query("SELECT tID FROM Tenants WHERE Email = 'tenant@example.com'")).rows[0].tid
        leaseId = (await t.owner.query("SELECT LeaseID FROM Lease LIMIT 1")).rows[0].leaseid
        unit102 = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '102'")).rows[0].uid
    })
    afterAll(async () => { await t?.drop() })

    describe("who is asking (row-level security)", () => {
        it("sees nothing with no identity, and everything as an admin", async () => {
            expect(await t.db.listProperties()).toEqual([])
            expect(await t.db.listLeases()).toEqual([])
            expect((await asAdmin(() => t.db.listProperties())).map((p) => p.name)).toEqual(["Woodcrest Apartments"])
        })

        it("a tenant sees only their own lease, person row and bank accounts", async () => {
            await asAdmin(() => t.db.inviteTenant({ name: "Other Person", email: "other@example.com", invite: invite().hash }))
            const people = await asTenant(tenantTid, () => t.db.listPeople())
            expect(people.map((p) => p.email)).toEqual(["tenant@example.com"])
            expect(await asTenant(tenantTid, () => t.db.listLeases())).toHaveLength(1)
            expect(await asAdmin(() => t.db.listBankAccounts(tenantTid))).toEqual([])   // not even staff
        })

        it("a tenant cannot write the lists staff manage", async () => {
            await expect(asTenant(tenantTid, () => t.db.saveProperty(null, { name: "Mine", address: "x" }))).rejects.toMatchObject({ code: "42501" })
        })

        it("the identity does not leak to the next caller on a pooled connection", async () => {
            await asAdmin(() => t.db.listProperties())
            expect(await t.db.listProperties()).toEqual([])
        })
    })

    describe("sign-in, invitations and sessions", () => {
        it("finds staff and signed-up tenants by email; an invited-only tenant cannot sign in", async () => {
            expect(await t.db.findUserByEmail("manager@example.com")).toMatchObject({ id: "admin:1", role: "admin", mfaEnabled: false })
            expect(await t.db.findUserByEmail("tenant@example.com")).toMatchObject({ id: `tenant:${tenantTid}`, role: "tenant" })
            expect(await t.db.findUserByEmail("other@example.com")).toBeNull()
        })

        it("an invite token signs the tenant up once, by its hash", async () => {
            const { token, hash: inv } = invite()
            await asAdmin(() => t.db.inviteTenant({ name: "New Tenant", email: "New.Tenant@Example.com", invite: inv }))
            expect(await t.db.completeSignup(hashToken("wrong"), "hash")).toBeNull()
            const user = await t.db.completeSignup(hashToken(token), "bcrypt-hash-here")
            expect(user).toMatchObject({ email: "new.tenant@example.com", role: "tenant" })
            expect(await t.db.completeSignup(hashToken(token), "again")).toBeNull()
            expect(await t.db.findUserByEmail("new.tenant@example.com")).toMatchObject({ passwordHash: "bcrypt-hash-here" })
        })

        it("an expired invite no longer works until the office sends a new one", async () => {
            const first = invite()
            const person = await asAdmin(() => t.db.inviteTenant({ name: "Late Tenant", email: "late@example.com", invite: { ...first.hash, expiresAt: new Date(Date.now() - 1000) } }))
            expect(await t.db.completeSignup(hashToken(first.token), "x")).toBeNull()
            const second = invite()
            await asAdmin(() => t.db.reissueInvite(Number(person.id.split(":")[1]), second.hash))
            expect(await t.db.completeSignup(hashToken(first.token), "x")).toBeNull()   // the old link stays dead
            expect(await t.db.completeSignup(hashToken(second.token), "x")).not.toBeNull()
        })

        it("a duplicate email is EMAIL_IN_USE, including an email that belongs to staff", async () => {
            await expect(asAdmin(() => t.db.inviteTenant({ name: "Dup", email: "tenant@example.com", invite: invite().hash }))).rejects.toMatchObject({ code: "EMAIL_IN_USE" })
            await expect(asAdmin(() => t.db.inviteTenant({ name: "Dup", email: "manager@example.com", invite: invite().hash }))).rejects.toMatchObject({ code: "EMAIL_IN_USE" })
        })

        it("a refresh token is used up once, and a deactivated account's token is dead", async () => {
            await t.db.storeRefreshToken({ userId: `tenant:${tenantTid}`, tokenHash: hashToken("rt-1"), expiresAt: new Date(Date.now() + 60_000) })
            expect(await t.db.consumeRefreshToken(hashToken("rt-1"))).toEqual({ id: `tenant:${tenantTid}`, email: "tenant@example.com", role: "tenant" })
            expect(await t.db.consumeRefreshToken(hashToken("rt-1"))).toBeNull()
            expect(await t.db.consumeRefreshToken(hashToken("never-issued"))).toBeNull()

            await t.db.storeRefreshToken({ userId: "admin:1", tokenHash: hashToken("rt-2"), expiresAt: new Date(Date.now() - 1000) })
            expect(await t.db.consumeRefreshToken(hashToken("rt-2"))).toBeNull()   // expired

            await t.db.storeRefreshToken({ userId: "admin:1", tokenHash: hashToken("rt-3"), expiresAt: new Date(Date.now() + 60_000) })
            await t.db.revokeRefreshToken(hashToken("rt-3"))
            expect(await t.db.consumeRefreshToken(hashToken("rt-3"))).toBeNull()
        })

        it("nobody can read the token table directly", async () => {
            await expect(t.app.query("SELECT * FROM Refresh_Tokens")).rejects.toMatchObject({ code: "42501" })
        })
    })

    describe("leases and rent", () => {
        it("a new lease bills the months already due, and the balance comes from the view", async () => {
            const created = await asAdmin(() => t.db.createLease({
                unitId: unit102, startDate: "2026-08-15", endDate: null, monthlyRent: 900,
                tenantIds: [], newTenants: [{ name: "Roommate A", email: "a@example.com", phone: null, invite: invite().hash }],
            }, TODAY_TEXT))
            expect(created.newTenantIds).toHaveLength(1)

            const charges = await asAdmin(() => t.db.listChargesForLease(created.leaseId))
            expect(charges.map((c) => c.dueDate)).toEqual(["2026-08-15", "2026-09-01", "2026-10-01"])
            const balances = await asAdmin(() => t.db.listLeaseBalances())
            expect(balances.find((b) => b.leaseId === created.leaseId)).toMatchObject({ charged: 2700, paid: 0, balance: 2700 })
        })

        it("refuses a second lease that overlaps in time on the same unit", async () => {
            await expect(asAdmin(() => t.db.createLease({
                unitId: unit102, startDate: "2026-09-01", endDate: null, monthlyRent: 1, tenantIds: [tenantTid], newTenants: [],
            }, TODAY_TEXT))).rejects.toMatchObject({ code: "UNIT_OCCUPIED" })
        })

        it("rent generation is safe to repeat", async () => {
            expect(await runAs({ type: "system" }, () => t.db.generateRentCharges(TODAY_TEXT))).toBe(0)
            // Next month arrives: exactly one new charge per open lease.
            expect(await runAs({ type: "system" }, () => t.db.generateRentCharges("2026-11-01"))).toBe(2)
            expect(await runAs({ type: "system" }, () => t.db.generateRentCharges("2026-11-01"))).toBe(0)
        })

        it("only admin or system can bill rent", async () => {
            expect(await t.db.generateRentCharges("2027-01-01")).toBe(0)
            expect(await asTenant(tenantTid, () => t.db.generateRentCharges("2027-01-01"))).toBe(0)
        })

        it("a lease keeps at least one tenant, and a retired unit takes no lease", async () => {
            const only = await asAdmin(() => t.db.listLeaseTenants(leaseId))
            expect(only).toHaveLength(1)
            await expect(asAdmin(() => t.db.removeTenantFromLease(leaseId, only[0]!.id))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })

            const unitId = (await asAdmin(() => t.db.saveUnit(null, { propertyId: 1, unitNum: "Z9" })))
            await asAdmin(() => t.db.deactivateUnit(unitId, TODAY_TEXT))
            await expect(asAdmin(() => t.db.createLease({ unitId, startDate: "2026-10-01", endDate: null, monthlyRent: 5, tenantIds: [tenantTid], newTenants: [] }, TODAY_TEXT)))
                .rejects.toMatchObject({ code: "UNIT_INACTIVE" })
        })

        it("will not retire a unit, property or tenant that is on a current lease", async () => {
            const unitId = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '101'")).rows[0].uid
            await expect(asAdmin(() => t.db.deactivateUnit(unitId, TODAY_TEXT))).rejects.toMatchObject({ code: "UNIT_HAS_LEASES" })
            await expect(asAdmin(() => t.db.deactivateProperty(1, TODAY_TEXT))).rejects.toMatchObject({ code: "PROPERTY_HAS_LEASES" })
            await expect(asAdmin(() => t.db.deactivateTenant(tenantTid, TODAY_TEXT))).rejects.toMatchObject({ code: "TENANT_ON_LEASE" })
        })

        it("ending a lease lets the unit's tenant be retired, and retired tenants drop out of lists", async () => {
            const unit103 = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '103'")).rows[0].uid
            const created = await asAdmin(() => t.db.createLease({
                unitId: unit103,
                startDate: "2026-01-01", endDate: "2026-03-31", monthlyRent: 500, tenantIds: [], newTenants: [{ name: "Past Tenant", email: "past@example.com", phone: null, invite: invite().hash }],
            }, TODAY_TEXT))
            await asAdmin(() => t.db.deactivateTenant(created.newTenantIds[0]!, TODAY_TEXT))
            expect((await asAdmin(() => t.db.listPeople())).map((p) => p.email)).not.toContain("past@example.com")
            await expect(asAdmin(() => t.db.updateLease(created.leaseId, { endDate: "2025-12-31" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        })
    })

    describe("payments", () => {
        it("the office records a payment; the ledger side shows who and how", async () => {
            await asAdmin(() => t.db.recordPayment({ leaseId, amount: 400, tenantId: tenantTid, method: "Check (recorded by office)", confirmation: "OFF-10000001" }))
            const payments = await asAdmin(() => t.db.listPaymentsForLease(leaseId))
            expect(payments).toHaveLength(1)
            expect(payments[0]).toMatchObject({ direction: "charge", status: "completed", amount: 400, method: "Check (recorded by office)", confirmation: "OFF-10000001", payerId: tenantTid })
        })

        it("a tenant's own payment is written as 'system' after the tenant is checked against the lease", async () => {
            await asTenant(tenantTid, () => t.db.recordPayment({ leaseId, amount: 100, tenantId: tenantTid, method: "Bank transfer", confirmation: "CONF-20000001" }))
            const row = (await t.owner.query("SELECT transaction_id FROM Payment WHERE transaction_id = 'CONF-20000001'")).rows
            expect(row).toHaveLength(1)
            const audit = (await t.owner.query("SELECT changed_by FROM audit_log WHERE table_name = 'payment' AND new_data->>'transaction_id' = 'CONF-20000001'")).rows
            expect(audit[0].changed_by).toBe("system")
        })

        it("a tenant cannot pay on a lease that is not theirs, nor name another payer", async () => {
            const otherLease = (await t.owner.query("SELECT LeaseID FROM Lease WHERE LeaseID <> $1 LIMIT 1", [leaseId])).rows[0].leaseid
            await expect(asTenant(tenantTid, () => t.db.recordPayment({ leaseId: otherLease, amount: 5, tenantId: tenantTid, method: "x", confirmation: "CONF-20000002" }))).rejects.toMatchObject({ code: "NOT_FOUND" })
            await expect(asTenant(tenantTid, () => t.db.recordPayment({ leaseId, amount: 5, tenantId: 999, method: "x", confirmation: "CONF-20000003" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
            // and a tenant cannot attach a receipt (staff only)
            await expect(asTenant(tenantTid, () => t.db.recordPayment({
                leaseId, amount: 5, tenantId: tenantTid, method: "x", confirmation: "CONF-20000004",
                receipt: { filename: "r.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4") },
            }))).rejects.toMatchObject({ code: "FORBIDDEN" })
        })

        it("payments cannot be deleted or edited, even by the app's own login", async () => {
            await expect(t.app.query("DELETE FROM Payment")).rejects.toMatchObject({ code: "42501" })
            await expect(t.app.query("UPDATE Payment SET amount = 1")).rejects.toMatchObject({ code: "42501" })
        })

        it("reversing an office payment adds a refund; a second reversal and a tenant payment are refused", async () => {
            const before = (await asAdmin(() => t.db.listLeaseBalances())).find((b) => b.leaseId === leaseId)!.balance
            const office = (await asAdmin(() => t.db.listPaymentsForLease(leaseId))).find((p) => p.confirmation === "OFF-10000001")!
            await asAdmin(() => t.db.reverseOfficePayment(leaseId, office.id))
            const after = (await asAdmin(() => t.db.listLeaseBalances())).find((b) => b.leaseId === leaseId)!.balance
            expect(after).toBe(before + 400)

            await expect(asAdmin(() => t.db.reverseOfficePayment(leaseId, office.id))).rejects.toMatchObject({ code: "PAYMENT_ALREADY_REVERSED" })
            const tenantPayment = (await asAdmin(() => t.db.listPaymentsForLease(leaseId))).find((p) => p.confirmation === "CONF-20000001")!
            await expect(asAdmin(() => t.db.reverseOfficePayment(leaseId, tenantPayment.id))).rejects.toMatchObject({ code: "NOT_OFFICE_PAYMENT" })
            await expect(asAdmin(() => t.db.reverseOfficePayment(leaseId, 999_999))).rejects.toMatchObject({ code: "NOT_FOUND" })
        })

        it("a receipt is saved with its payment, and only staff can read it", async () => {
            const receipt = { filename: "check.pdf", contentType: "application/pdf" as const, data: Buffer.from("%PDF-1.4 test") }
            await asAdmin(() => t.db.recordPayment({ leaseId, amount: 50, tenantId: null, method: "Cash (recorded by office)", confirmation: "OFF-10000002", receipt }))
            const pay = (await asAdmin(() => t.db.listPaymentsForLease(leaseId))).find((p) => p.confirmation === "OFF-10000002")!
            expect(pay.payerId).toBeNull()
            expect(await asAdmin(() => t.db.listReceiptPaymentIds(leaseId))).toEqual([pay.id])
            expect((await asAdmin(() => t.db.findReceipt(leaseId, pay.id)))?.data.toString()).toBe("%PDF-1.4 test")
            expect(await asTenant(tenantTid, () => t.db.findReceipt(leaseId, pay.id))).toBeNull()
        })

        it("recent payments list completed money in, newest first", async () => {
            const recent = await asAdmin(() => t.db.listRecentPayments(10))
            expect(recent.length).toBeGreaterThanOrEqual(3)
            expect(recent.every((r) => r.amount > 0)).toBe(true)
        })
    })

    describe("maintenance", () => {
        it("a tenant files a request for their own unit; it shows with a title for them and for staff", async () => {
            const unitId = (await t.owner.query("SELECT uID FROM Units WHERE UnitNum = '101'")).rows[0].uid
            const created = await asTenant(tenantTid, () => t.db.createMaintenance({ unitId, tenantId: tenantTid, title: "Leaky faucet", description: "drip" }))
            expect((await asTenant(tenantTid, () => t.db.listTenantMaintenance(tenantTid))).map((r) => r.title)).toEqual(["Leaky faucet"])
            expect((await asAdmin(() => t.db.listMaintenance()))[0]).toMatchObject({ title: "Leaky faucet", status: "submitted", tenantName: "Test Tenant" })
            expect(await asAdmin(() => t.db.listOpenRequestCounts())).toEqual([{ unitId, count: 1 }])

            await asAdmin(() => t.db.setMaintenanceStatus(created.id, "resolved"))
            expect(await asAdmin(() => t.db.listOpenRequestCounts())).toEqual([])
            // the schema keeps a status history on its own
            const history = (await t.owner.query("SELECT old_status, new_status FROM Maintenance_Status_History WHERE mID = $1 ORDER BY histID", [created.id])).rows
            expect(history).toEqual([{ old_status: null, new_status: "submitted" }, { old_status: "submitted", new_status: "resolved" }])
        })

        it("a tenant cannot file for a unit they do not lease", async () => {
            await expect(asTenant(tenantTid, () => t.db.createMaintenance({ unitId: unit102, tenantId: tenantTid, title: "x", description: "" }))).rejects.toMatchObject({ code: "NOT_FOUND" })
        })

        it("removing a request retires it from every list", async () => {
            const id = (await asAdmin(() => t.db.createMaintenance({ unitId: unit102, tenantId: null, title: "Filed by office", description: "" }))).id
            await asAdmin(() => t.db.deactivateMaintenance(id))
            expect((await asAdmin(() => t.db.listMaintenance())).map((m) => m.title)).not.toContain("Filed by office")
            await expect(asAdmin(() => t.db.deactivateMaintenance(id))).rejects.toMatchObject({ code: "NOT_FOUND" })
        })
    })

    describe("bank accounts", () => {
        it("a tenant saves and reads their own; saving again updates instead of duplicating", async () => {
            const save = () => asTenant(tenantTid, () => t.db.saveBankAccounts(tenantTid, { itemId: "item-1", accessTokenEnc: "v1.x.y.z" }, [{ accountId: "acc-1", name: "Checking", mask: "0000", subtype: "checking" }]))
            await save()
            await save()
            const accounts = await asTenant(tenantTid, () => t.db.listBankAccounts(tenantTid))
            expect(accounts).toHaveLength(1)
            expect(await asTenant(tenantTid, () => t.db.findBankAccount(tenantTid, accounts[0]!.id))).toMatchObject({ name: "Checking" })
            expect(await asTenant(tenantTid + 1, () => t.db.findBankAccount(tenantTid, accounts[0]!.id))).toBeNull()
        })
    })

    describe("properties and units", () => {
        it("a unit number clashes case-insensitively inside one property", async () => {
            await asAdmin(() => t.db.saveUnit(null, { propertyId: 1, unitNum: "B2" }))
            await expect(asAdmin(() => t.db.saveUnit(null, { propertyId: 1, unitNum: "b2" }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
        })

        it("a property with no leases can be retired with its units", async () => {
            const pid = await asAdmin(() => t.db.saveProperty(null, { name: "Entered by mistake", address: "nowhere" }))
            await asAdmin(() => t.db.saveUnit(null, { propertyId: pid, unitNum: "1" }))
            await asAdmin(() => t.db.deactivateProperty(pid, TODAY_TEXT))
            expect((await asAdmin(() => t.db.listProperties())).map((p) => p.name)).not.toContain("Entered by mistake")
            expect((await asAdmin(() => t.db.listUnits(pid)))).toEqual([])
        })
    })
})
