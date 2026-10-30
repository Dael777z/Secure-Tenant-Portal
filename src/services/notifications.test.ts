import { describe, expect, it } from "vitest"

import type { LeaseEndingRecord, PastDueRecord, Recipient, RentDueRecord } from "../types/records"
import type { NotificationStore } from "../types/stores"
import type { EmailSender, OutgoingEmail } from "./email"
import { sampleEmails } from "./email-templates"
import { NotificationService } from "./notifications"

const OPTIONS = { timeZone: "America/Denver", webOrigin: "https://portal.example.com", sendFromHour: 8, leaseEndingNoticeDays: 90 }
/** 10:00 in Denver on these days (UTC-6 in November, UTC-7 in October). */
const NOV_1 = new Date("2026-11-01T16:00:00Z")
const NOV_12 = new Date("2026-11-12T17:00:00Z")

const managers: Recipient[] = [{ name: "Pat Office", email: "pat@office.test" }, { name: "Sam Office", email: "sam@office.test" }]

function fakeStore(over: Partial<NotificationStore> = {}) {
    const sent = new Set<string>()
    const store: NotificationStore & { sent: Set<string> } = {
        sent,
        findTenantRecipient: async (tID) => ({ name: `Tenant ${tID}`, email: `t${tID}@home.test` }),
        listStaffRecipients: async () => managers,
        countUnreadFrom: async () => 1,
        listRentDue: async () => [],
        listPastDue: async () => [],
        listLeasesEnding: async () => [],
        findSentNotifications: async (keys) => new Set(keys.filter((k) => sent.has(k))),
        markNotificationSent: async (key) => { sent.add(key) },
        ...over,
    }
    return store
}

function fakeSender(fail: (email: OutgoingEmail) => boolean = () => false) {
    const outbox: OutgoingEmail[] = []
    const sender: EmailSender & { outbox: OutgoingEmail[] } = {
        outbox,
        async send(email) {
            if (fail(email)) throw new Error("Resend answered 500")
            outbox.push(email)
        },
    }
    return sender
}

const rentRow = (tenantId: number, balance = 1200): RentDueRecord =>
    ({ tenantId, name: `Tenant ${tenantId}`, email: `t${tenantId}@home.test`, leaseId: 10 + tenantId, unitLabel: "Unit 2B - Maple Court", monthlyRent: 1200, balance })

describe("event emails", () => {
    it("a tenant's message emails every property manager, without the message text", async () => {
        const email = fakeSender()
        await new NotificationService(fakeStore(), email, OPTIONS).tenantMessaged(5)
        expect(email.outbox.map((e) => e.to)).toEqual(["pat@office.test", "sam@office.test"])
        expect(email.outbox[0]).toMatchObject({ subject: "New message from Tenant 5" })
        expect(email.outbox[0]!.html).toContain("https://portal.example.com/#/messages/5")
    })

    it("only the first unopened message of a burst sends an email", async () => {
        const email = fakeSender()
        await new NotificationService(fakeStore({ countUnreadFrom: async () => 2 }), email, OPTIONS).tenantMessaged(5)
        await new NotificationService(fakeStore({ countUnreadFrom: async () => 3 }), email, OPTIONS).officeMessaged(5, "Pat Office")
        expect(email.outbox).toHaveLength(0)
    })

    it("the office's message emails the tenant", async () => {
        const email = fakeSender()
        await new NotificationService(fakeStore(), email, OPTIONS).officeMessaged(7, "Pat Office")
        expect(email.outbox.map((e) => [e.to, e.subject])).toEqual([["t7@home.test", "New message from the property office"]])
        expect(email.outbox[0]!.text).toContain("Pat Office from the property office")
    })

    it("a maintenance request goes to the managers who keep those emails on, with names escaped", async () => {
        let askedForMaintenance: boolean | null = null
        const store = fakeStore({ listStaffRecipients: async (maintenance) => { askedForMaintenance = maintenance; return [managers[0]!] } })
        const email = fakeSender()
        await new NotificationService(store, email, OPTIONS).maintenanceFiled({ requestId: 3, tenantId: 5, unitLabel: "Unit 2B - Maple Court", title: "Sink <leaks>", description: "Under the sink" })
        expect(askedForMaintenance).toBe(true)
        expect(email.outbox).toHaveLength(1)
        expect(email.outbox[0]!.subject).toBe("New maintenance request: Sink <leaks>")
        expect(email.outbox[0]!.html).toContain("Sink &lt;leaks&gt;")
        expect(email.outbox[0]!.html).not.toContain("<leaks>")
    })

    it("never rejects, even when sending or the database fails", async () => {
        const failing = new NotificationService(fakeStore({ countUnreadFrom: async () => { throw new Error("db down") } }), fakeSender(), OPTIONS)
        await expect(failing.tenantMessaged(5)).resolves.toBeUndefined()
        const badSend = new NotificationService(fakeStore(), fakeSender(() => true), OPTIONS)
        await expect(badSend.officeMessaged(5, null)).resolves.toBeUndefined()
    })

    it("does nothing with email off", async () => {
        let asked = false
        const service = new NotificationService(fakeStore({ countUnreadFrom: async () => { asked = true; return 1 } }), null, OPTIONS)
        await service.tenantMessaged(5)
        expect(asked).toBe(false)
        expect(await service.run(NOV_1)).toMatchObject({ skipped: "email off" })
    })
})

describe("scheduled emails", () => {
    it("on the 1st: bills this month's rent first, then emails each tenant once", async () => {
        let billed = 0
        const store = fakeStore({ listRentDue: async () => [rentRow(1), rentRow(2, 0)] })
        const email = fakeSender()
        const service = new NotificationService(store, email, OPTIONS, { run: async () => ++billed })

        expect(await service.run(NOV_1)).toEqual({ sent: 2, failed: 0 })
        expect(billed).toBe(1)
        expect(email.outbox.map((e) => e.subject)).toEqual(["Your November rent is due", "Your November rent is due"])
        expect(email.outbox[0]!.text).toContain("Your balance is now $1,200.00")
        expect(email.outbox[1]!.text).toContain("no balance due")
        expect([...store.sent]).toEqual(["rent_due:1:2026-11", "rent_due:2:2026-11"])

        // the next hour: nothing new
        expect(await service.run(new Date(NOV_1.getTime() + 3600_000))).toEqual({ sent: 0, failed: 0 })
        expect(email.outbox).toHaveLength(2)
    })

    it("sends no rent email on other days, and nothing before the morning", async () => {
        let asked = false
        const store = fakeStore({ listRentDue: async () => { asked = true; return [rentRow(1)] } })
        const email = fakeSender()
        const service = new NotificationService(store, email, OPTIONS)
        expect(await service.run(NOV_12)).toEqual({ sent: 0, failed: 0 })
        expect(asked).toBe(false)
        expect(await service.run(new Date("2026-11-01T12:00:00Z"))).toMatchObject({ skipped: "too early" })   // 05:00 in Denver
    })

    it("past due: one email per tenant per unpaid bill", async () => {
        const row: PastDueRecord = { tenantId: 4, name: "Lee Renter", email: "lee@home.test", leaseId: 9, unitLabel: "Unit 1 - Oak", chargeId: 55, dueDate: "2026-11-01", balance: 950 }
        const store = fakeStore({ listPastDue: async () => [row] })
        const email = fakeSender()
        const service = new NotificationService(store, email, OPTIONS)
        await service.run(NOV_12)
        await service.run(NOV_12)
        expect(email.outbox).toHaveLength(1)
        expect(email.outbox[0]).toMatchObject({ to: "lee@home.test", subject: "Your rent payment is past due", idempotencyKey: "past_due:4:55:lee@home.test" })
        expect(email.outbox[0]!.text).toContain("was due on November 1, 2026")
        expect(email.outbox[0]!.text).toContain("$950.00")
    })

    it("lease ending: every manager hears once, with the days left", async () => {
        const lease: LeaseEndingRecord = { leaseId: 9, endDate: "2027-02-10", unitLabel: "Unit 1 - Oak", tenantNames: "Lee Renter" }
        let window = 0
        const store = fakeStore({ listLeasesEnding: async (_today, days) => { window = days; return [lease] } })
        const email = fakeSender()
        const service = new NotificationService(store, email, OPTIONS)
        await service.run(NOV_12)
        await service.run(NOV_12)
        expect(window).toBe(90)
        expect(email.outbox.map((e) => e.to)).toEqual(["pat@office.test", "sam@office.test"])
        expect(email.outbox[0]!.subject).toBe("Lease ending February 10, 2027: Unit 1 - Oak")
        expect(email.outbox[0]!.text).toContain("90 days from now")
        expect(email.outbox[0]!.html).toContain("/#/leases/9")
    })

    it("a failed send is not recorded, so the next run tries again", async () => {
        const store = fakeStore({ listPastDue: async () => [{ tenantId: 4, name: "Lee", email: "lee@home.test", leaseId: 9, unitLabel: "Unit 1", chargeId: 55, dueDate: "2026-11-01", balance: 950 }] })
        let down = true
        const email = fakeSender(() => down)
        const service = new NotificationService(store, email, OPTIONS)
        expect(await service.run(NOV_12)).toEqual({ sent: 0, failed: 1 })
        expect(store.sent.size).toBe(0)
        down = false
        expect(await service.run(NOV_12)).toEqual({ sent: 1, failed: 0 })
        expect(store.sent.has("past_due:4:55")).toBe(true)
    })
})

describe("email-test samples", () => {
    it("are one of each email, marked as tests, with portal links", () => {
        const emails = sampleEmails("https://portal.example.com/", "2026-10-28")
        expect(emails.map((e) => e.subject)).toEqual([
            "[Test] Your October rent is due",
            "[Test] Your rent payment is past due",
            "[Test] New message from the property office",
            "[Test] New message from Test Tenant",
            "[Test] Lease ending January 26, 2027: Unit 101 - Sample Apartments",
            "[Test] New maintenance request: Kitchen sink is leaking",
        ])
        for (const e of emails) {
            expect(e.html).toContain("https://portal.example.com/")
            expect(e.text).toContain("https://portal.example.com/")
        }
    })
})
