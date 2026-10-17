// What feature/combined adds on top of the refactor: the maintenance staff role
// (003), charges the office adds by hand, a sign-in reset link for a signed-up
// tenant, and idempotent tenant payments. Skipped unless TEST_DATABASE_URL is set.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runAs, type Identity } from "../db/identity"
import { seed } from "../db/seed"
import { hashToken, newInvite, randomToken } from "../utils/tokens"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const TODAY = new Date("2026-10-16T18:00:00Z")
const admin: Identity = { type: "admin", id: 1, role: "admin" }

describe.skipIf(!hasDatabase)("team additions on the Summit schema", () => {
    let t: TestDatabase
    let staff: Identity            // maintenance@example.com
    let tenantTid: number          // tenant@example.com, on unit 101
    let leaseId: number

    const as = <T>(who: Identity, work: () => Promise<T>) => runAs(who, work)
    const asTenant = <T>(id: number, work: () => Promise<T>) => runAs({ type: "tenant", id }, work)

    beforeAll(async () => {
        t = await freshDatabase("it_team")
        await seed(t.owner, { dataset: "clean", webOrigin: "http://localhost:5173", bcryptRounds: 4, today: TODAY })
        const staffId = (await t.owner.query("SELECT admin_id FROM Admin WHERE email = 'maintenance@example.com'")).rows[0].admin_id
        staff = { type: "admin", id: staffId, role: "maintenance_staff" }
        tenantTid = (await t.owner.query("SELECT tID FROM Tenants WHERE Email = 'tenant@example.com'")).rows[0].tid
        leaseId = (await t.owner.query("SELECT LeaseID FROM Lease LIMIT 1")).rows[0].leaseid
    })
    afterAll(async () => { await t?.drop() })

    describe("maintenance staff", () => {
        it("sign in with their own role, and keep it across a session refresh", async () => {
            const user = await t.db.findUserByEmail("maintenance@example.com")
            expect(user).toMatchObject({ role: "maintenance_staff" })
            const { token, hash } = randomToken()
            await t.db.storeRefreshToken({ userId: user!.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) })
            expect(await t.db.consumeRefreshToken(hashToken(token))).toMatchObject({ id: user!.id, role: "maintenance_staff" })
        })

        it("see the queue, the units and who reported each request, and their own profile", async () => {
            const units = await as(staff, () => t.db.listUnits())
            expect(units.length).toBeGreaterThan(0)
            await as(admin, () => t.db.createMaintenance({ unitId: units[0]!.id, tenantId: null, title: "Smoke detector chirping", description: "" }))
            expect((await as(staff, () => t.db.listMaintenance())).map((m) => m.title)).toContain("Smoke detector chirping")
            expect(await as(staff, () => t.db.findStaffProfile((staff as { id: number }).id))).toMatchObject({ role: "maintenance_staff" })
        })

        it("file a request and move it along", async () => {
            const units = await as(staff, () => t.db.listUnits())
            const { id } = await as(staff, () => t.db.createMaintenance({ unitId: units[0]!.id, tenantId: null, title: "Hallway light out", description: "Third floor" }))
            await as(staff, () => t.db.setMaintenanceStatus(id, "in_progress"))
            const row = (await as(staff, () => t.db.listMaintenance())).find((m) => m.id === id)
            expect(row).toMatchObject({ status: "in_progress" })
        })

        it("see no leases, money or bank accounts, and cannot change them", async () => {
            expect(await as(staff, () => t.db.listLeases())).toEqual([])
            expect(await as(staff, () => t.db.listLeaseBalances())).toEqual([])
            expect(await as(staff, () => t.db.listChargesForLease(leaseId))).toEqual([])
            expect(await as(staff, () => t.db.listPaymentsForLease(leaseId))).toEqual([])
            expect(await as(staff, () => t.db.listBankAccounts(tenantTid))).toEqual([])
            await expect(as(staff, () => t.db.recordPayment({ leaseId, amount: 5, tenantId: null, method: "Cash", confirmation: "OFF-99999999" })))
                .rejects.toMatchObject({ code: "NOT_FOUND" })
            await expect(as(staff, () => t.db.addCharge({ leaseId, kind: "late_fee", amount: 5, dueDate: "2026-10-16", description: null })))
                .rejects.toMatchObject({ code: "NOT_FOUND" })
            await expect(as(staff, () => t.db.saveProperty(null, { name: "Not theirs", address: "x" }))).rejects.toMatchObject({ code: "42501" })
        })
    })

    describe("charges the office adds", () => {
        it("a late fee shows on the lease and raises the balance", async () => {
            const before = (await as(admin, () => t.db.listLeaseBalances())).find((b) => b.leaseId === leaseId)!.balance
            await as(admin, () => t.db.addCharge({ leaseId, kind: "late_fee", amount: 25, dueDate: "2026-10-16", description: "Late fee, October" }))
            const charges = await as(admin, () => t.db.listChargesForLease(leaseId))
            expect(charges.at(-1)).toMatchObject({ kind: "late_fee", amount: 25, description: "Late fee, October" })
            const after = (await as(admin, () => t.db.listLeaseBalances())).find((b) => b.leaseId === leaseId)!.balance
            expect(after).toBe(before + 25)
        })

        it("is refused for an unknown lease, and for a tenant", async () => {
            await expect(as(admin, () => t.db.addCharge({ leaseId: 999_999, kind: "other", amount: 5, dueDate: "2026-10-16", description: null })))
                .rejects.toMatchObject({ code: "NOT_FOUND" })
            await expect(asTenant(tenantTid, () => t.db.addCharge({ leaseId, kind: "other", amount: 5, dueDate: "2026-10-16", description: null })))
                .rejects.toMatchObject({ code: "42501" })
        })
    })

    describe("sign-in reset", () => {
        it("stops the old password and every session; the new link signs them back in once", async () => {
            const { token, hash } = randomToken()
            await t.db.storeRefreshToken({ userId: `tenant:${tenantTid}`, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) })

            const fresh = newInvite()
            await as(admin, () => t.db.resetSignIn(tenantTid, fresh.invite))
            expect(await t.db.findUserByEmail("tenant@example.com")).toBeNull()
            expect(await t.db.consumeRefreshToken(hashToken(token))).toBeNull()

            expect(await t.db.completeSignup(hashToken(fresh.token), "$2b$04$abcdefghijklmnopqrstuuJ8m1t5dBz0pE1uYwz7o9g0oF8Hq3a2e")).toMatchObject({ id: `tenant:${tenantTid}` })
            expect(await t.db.completeSignup(hashToken(fresh.token), "$2b$04$abcdefghijklmnopqrstuuJ8m1t5dBz0pE1uYwz7o9g0oF8Hq3a2e")).toBeNull()
            expect(await t.db.findUserByEmail("tenant@example.com")).toMatchObject({ role: "tenant" })
        })

        it("is for signed-up tenants only (an invited one gets their invite again instead)", async () => {
            const invited = await as(admin, () => t.db.inviteTenant({ name: "Still Invited", email: "invited@example.com", invite: newInvite().invite }))
            const tid = Number(invited.id.split(":")[1])
            await expect(as(admin, () => t.db.resetSignIn(tid, newInvite().invite))).rejects.toMatchObject({ code: "TENANT_NOT_SIGNED_UP" })
            await expect(asTenant(tenantTid, () => t.db.resetSignIn(tenantTid, newInvite().invite))).rejects.toMatchObject({ code: "NOT_FOUND" })
        })
    })

    describe("tenant payments are recorded once per checkout", () => {
        const pay = (confirmation: string, idempotencyKey: string | null) =>
            asTenant(tenantTid, () => t.db.recordPayment({ leaseId, amount: 10, tenantId: tenantTid, method: "Bank transfer", confirmation, idempotencyKey }))
        const count = async () => (await t.owner.query("SELECT count(*)::int AS n FROM Payment WHERE LeaseID = $1", [leaseId])).rows[0].n

        it("the same key twice is one payment, and answers with the first confirmation", async () => {
            const before = await count()
            expect(await pay("CONF-30000001", `tenant:${tenantTid}:checkout-aaaa`)).toEqual({ confirmation: "CONF-30000001" })
            expect(await pay("CONF-30000002", `tenant:${tenantTid}:checkout-aaaa`)).toEqual({ confirmation: "CONF-30000001" })
            expect(await count()).toBe(before + 1)
        })

        it("a new key, or no key, is a new payment", async () => {
            const before = await count()
            await pay("CONF-30000003", `tenant:${tenantTid}:checkout-bbbb`)
            await pay("CONF-30000004", null)
            expect(await count()).toBe(before + 2)
        })
    })
})
