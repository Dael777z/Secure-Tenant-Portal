// Email notifications (005): the notify_* functions on a real database, and the
// scheduled run end to end with a fake sender. Skipped without TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { runAs } from "../db/identity"
import type { OutgoingEmail } from "../services/email"
import { NotificationService } from "../services/notifications"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const OPTIONS = { timeZone: "America/Denver", webOrigin: "https://portal.example.com", sendFromHour: 8, leaseEndingNoticeDays: 90 }

describe.skipIf(!hasDatabase)("email notifications (005)", () => {
    let t: TestDatabase
    let lee: number         // on a lease that owes November's rent
    let kim: number         // on a paid-up lease ending in 60 days, no renewal
    let pat: number         // manager, maintenance emails on
    let sam: number         // manager, maintenance emails off
    let owingLease: number
    let endingLease: number
    let renewedLease: number
    let novCharge: number

    const one = async <T>(sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows[0] as T

    beforeAll(async () => {
        t = await freshDatabase("it_notifications")
        const property = (await one<{ id: number }>("INSERT INTO Property (Name, Address) VALUES ('Maple Court', '1 Maple St') RETURNING pID AS id")).id
        const unit = async (num: string) => (await one<{ id: number }>("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS id", [property, num])).id
        const tenant = async (name: string, email: string) => (await one<{ id: number }>("INSERT INTO Tenants (Name, Email) VALUES ($1, $2) RETURNING tID AS id", [name, email])).id
        const admin = async (name: string, email: string, role = "admin") =>
            (await one<{ id: number }>("INSERT INTO Admin (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING admin_id AS id", [name, email, role])).id
        const lease = async (uID: number, start: string, end: string | null, tenants: number[]) => {
            const id = (await one<{ id: number }>("INSERT INTO Lease (uID, start_date, end_date, monthly_rent) VALUES ($1, $2, $3, 1000) RETURNING LeaseID AS id", [uID, start, end])).id
            for (const tID of tenants) await t.owner.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [id, tID])
            return id
        }
        const charge = async (leaseId: number, due: string) =>
            (await one<{ id: number }>("INSERT INTO Charge (LeaseID, kind, amount, due_date) VALUES ($1, 'rent', 1000, $2) RETURNING chargeID AS id", [leaseId, due])).id
        const pay = (leaseId: number, status: string, txn: string) =>
            t.owner.query("INSERT INTO Payment (LeaseID, amount, status, transaction_id) VALUES ($1, 1000, $2, $3)", [leaseId, status, txn])

        lee = await tenant("Lee Renter", "lee@home.test")
        kim = await tenant("Kim Short", "kim@home.test")
        const gone = await tenant("Gone Tenant", "gone@home.test")
        const renewer = await tenant("Ray Renew", "ray@home.test")
        pat = await admin("Pat Office", "pat@office.test")
        sam = await admin("Sam Office", "sam@office.test")
        await admin("Max Fixit", "max@office.test", "maintenance_staff")
        await admin("Old Manager", "old@office.test")
        await t.owner.query("UPDATE Admin SET deactivated_at = now() WHERE email = 'old@office.test'")

        // Lee (and a deactivated co-tenant): October paid, November not, a pending payment that does not count.
        owingLease = await lease(await unit("1A"), "2026-10-01", null, [lee, gone])
        await t.owner.query("UPDATE Tenants SET deactivated_at = now() WHERE tID = $1", [gone])
        await charge(owingLease, "2026-10-01")
        novCharge = await charge(owingLease, "2026-11-01")
        await pay(owingLease, "completed", "txn-oct")
        await pay(owingLease, "pending", "txn-nov-pending")

        // Kim: paid up, lease ends 2027-01-11 (60 days after 2026-11-12), nothing after it.
        endingLease = await lease(await unit("2B"), "2026-02-01", "2027-01-11", [kim])
        await charge(endingLease, "2026-11-01")
        await pay(endingLease, "completed", "txn-kim")

        // Ray: ending soon too, but the unit's next lease is already signed.
        const unit3 = await unit("3C")
        renewedLease = await lease(unit3, "2026-01-01", "2026-12-31", [renewer])
        await lease(unit3, "2027-01-01", "2027-12-31", [renewer])
    })
    afterAll(async () => {
        await t?.drop()
    })

    it("returns nothing to anyone but 'system'", async () => {
        for (const sql of ["SELECT * FROM notify_staff(false)", "SELECT * FROM notify_tenant($1)", "SELECT * FROM notify_past_due('2026-11-12')"]) {
            const params = sql.includes("$1") ? [lee] : []
            expect((await t.app.query(sql, params)).rows).toEqual([])   // no identity at all
        }
        // nor to a property manager
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'admin', true), set_config('app.user_id', $1, true), set_config('app.user_role', 'admin', true)", [String(pat)])
            expect((await client.query("SELECT * FROM notify_tenant($1)", [lee])).rows).toEqual([])
            expect((await client.query("SELECT * FROM Notifications_Sent")).rows).toEqual([])
            await client.query("ROLLBACK")
        } finally {
            client.release()
        }
    })

    it("finds active tenants and active property managers only; the maintenance switch narrows the list", async () => {
        expect(await t.db.findTenantRecipient(lee)).toEqual({ name: "Lee Renter", email: "lee@home.test" })
        expect((await t.db.listStaffRecipients(false)).map((r) => r.email)).toEqual(["pat@office.test", "sam@office.test"])

        await runAs({ type: "admin", id: sam, role: "admin" }, () => t.db.setMaintenanceEmails(sam, false))
        expect((await t.db.listStaffRecipients(true)).map((r) => r.email)).toEqual(["pat@office.test"])
        expect(await runAs({ type: "admin", id: sam, role: "admin" }, () => t.db.findStaffProfile(sam))).toMatchObject({ notifyMaintenance: false })
        await runAs({ type: "admin", id: sam, role: "admin" }, () => t.db.setMaintenanceEmails(sam, true))
    })

    it("past due: the oldest unpaid charge, once it is past its due date", async () => {
        expect(await t.db.listPastDue("2026-11-01")).toEqual([])   // due today is not past due
        expect(await t.db.listPastDue("2026-11-12")).toEqual([{
            tenantId: lee, name: "Lee Renter", email: "lee@home.test", leaseId: owingLease,
            unitLabel: "Unit 1A - Maple Court", chargeId: novCharge, dueDate: "2026-11-01", balance: 1000,
        }])
    })

    it("rent due: every tenant on a current lease, with the balance", async () => {
        const rows = await t.db.listRentDue("2026-11-01")
        expect(rows.map((r) => [r.email, r.balance]).sort()).toEqual([["kim@home.test", 0], ["lee@home.test", 1000], ["ray@home.test", 0]])
    })

    it("lease ending: within the window and not already renewed", async () => {
        expect(await t.db.listLeasesEnding("2026-11-12", 90)).toEqual([
            { leaseId: endingLease, endDate: "2027-01-11", unitLabel: "Unit 2B - Maple Court", tenantNames: "Kim Short" },
        ])
        expect(await t.db.listLeasesEnding("2026-11-12", 30)).toEqual([])
        expect((await t.db.listLeasesEnding("2026-11-12", 90)).some((l) => l.leaseId === renewedLease)).toBe(false)
    })

    it("counts the unopened messages one side wrote", async () => {
        await t.owner.query("INSERT INTO Messages (tID, body) VALUES ($1, 'hello'), ($1, 'are you there?')", [kim])
        expect(await t.db.countUnreadFrom(kim, false)).toBe(2)
        expect(await t.db.countUnreadFrom(kim, true)).toBe(0)
    })

    it("the scheduled run sends each email once", async () => {
        const outbox: OutgoingEmail[] = []
        const service = new NotificationService(t.db, { send: async (e) => { outbox.push(e) } }, OPTIONS)
        const morning = new Date("2026-11-12T17:00:00Z")   // 10:00 in Denver

        expect(await service.run(morning)).toEqual({ sent: 3, failed: 0 })
        expect(outbox.map((e) => [e.to, e.subject]).sort()).toEqual([
            ["lee@home.test", "Your rent payment is past due"],
            ["pat@office.test", "Lease ending January 11, 2027: Unit 2B - Maple Court"],
            ["sam@office.test", "Lease ending January 11, 2027: Unit 2B - Maple Court"],
        ])
        expect(await t.db.findSentNotifications([`past_due:${lee}:${novCharge}`, `lease_ending:${endingLease}:2027-01-11`, "nope"]))
            .toEqual(new Set([`past_due:${lee}:${novCharge}`, `lease_ending:${endingLease}:2027-01-11`]))

        expect(await service.run(new Date(morning.getTime() + 3600_000))).toEqual({ sent: 0, failed: 0 })
        expect(outbox).toHaveLength(3)
    })
})
