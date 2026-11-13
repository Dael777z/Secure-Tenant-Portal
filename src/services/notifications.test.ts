import { describe, expect, it } from "vitest"

import type { NotificationStore } from "../types/stores"
import type { EmailSender, OutgoingEmail } from "./email"
import { lateRentEmail, maintenanceEmail, maintenanceUpdateEmail, noticeEmail, sampleEmails } from "./email-templates"
import { NotificationService } from "./notifications"

const OPTIONS = { timeZone: "America/Denver", webOrigin: "https://portal.example.com/", sendFromHour: 8, leaseEndingNoticeDays: 90 }

function fakeStore(over: Partial<NotificationStore> = {}): NotificationStore & { calls: string[] } {
    const calls: string[] = []
    const track = <T>(name: string, value: T) => async () => { calls.push(name); return value }
    return {
        calls,
        findTenantRecipient: track("findTenantRecipient", { name: "Lee Renter", email: "lee@home.test" }),
        listOfficeRecipients: track("listOfficeRecipients", [{ name: "Pat Office", email: "pat@office.test" }]),
        countUnreadFrom: track("countUnreadFrom", 1),
        listPastDue: track("listPastDue", []),
        listLeasesEnding: track("listLeasesEnding", []),
        findScheduledEmailsSent: track("findScheduledEmailsSent", new Set<string>()),
        markScheduledEmailSent: track("markScheduledEmailSent", undefined),
        queueNoticeEmails: track("queueNoticeEmails", 0),
        claimNoticeEmails: track("claimNoticeEmails", []),
        finishNoticeEmail: track("finishNoticeEmail", undefined),
        ...over,
    }
}

function fakeSender() {
    const sent: OutgoingEmail[] = []
    const sender: EmailSender = { async send(email) { sent.push(email) } }
    return { sender, sent }
}

describe("notification emails", () => {
    it("escape everything from the database, and keep line breaks in a notice", () => {
        const email = noticeEmail({ name: "<b>Lee</b> R", subject: "Water & power", body: "Line one\nLine <two>", portalUrl: "https://x.test/?a=1&b=2" })
        expect(email.html).toContain("Hi &lt;b&gt;Lee&lt;/b&gt;,")
        expect(email.html).toContain("Line one\nLine &lt;two&gt;")
        expect(email.html).toContain('href="https://x.test/?a=1&amp;b=2"')
        expect(email.html).not.toContain("<two>")
        expect(email.text).toContain("Line one\nLine <two>")   // the plain-text part is not HTML
    })

    it("cut a long maintenance description, and name a repair's new stage the way the portal does", () => {
        const long = maintenanceEmail({ managerName: "Pat", tenantName: "Lee", unitLabel: "Unit 1A", title: "Leak", description: "x".repeat(800), url: "https://x.test" })
        expect(long.text).toContain(`${"x".repeat(500)}…`)
        expect(maintenanceUpdateEmail({ name: "Lee", title: "Leak", status: "in_progress", portalUrl: "https://x.test" }).subject).toBe("Maintenance update: Leak (In progress)")
        expect(maintenanceUpdateEmail({ name: "Lee", title: "Leak", status: "resolved", portalUrl: "https://x.test" }).text).toContain("is complete")
    })

    it("sum up late rent in one email, listing at most 25 leases", () => {
        const leases = Array.from({ length: 30 }, (_, i) => ({ unitLabel: `Unit ${i}`, tenantNames: `T${i}`, dueDate: "2026-10-01", balance: 100 }))
        const email = lateRentEmail({ managerName: "Pat", today: "2026-11-06", leases, url: "https://x.test" })
        expect(email.subject).toBe("Late rent: 30 leases behind ($3,000.00)")
        expect(email.text).toContain("…and 5 more.")
        expect(lateRentEmail({ managerName: "Pat", today: "2026-11-06", leases: leases.slice(0, 1), url: "https://x.test" }).subject).toBe("Late rent: 1 lease behind ($100.00)")
    })

    it("have one sample of each for email-test", () => {
        const samples = sampleEmails("https://portal.example.com", "2026-11-06")
        expect(samples).toHaveLength(9)
        expect(samples.every((e) => e.subject.startsWith("[Test] "))).toBe(true)
    })
})

describe("NotificationService", () => {
    it("does nothing at all without a sender (RESEND_API_KEY unset)", async () => {
        const db = fakeStore()
        const service = new NotificationService(db, null, OPTIONS)
        expect(service.enabled).toBe(false)
        await service.tenantMessaged(1)
        await service.officeMessaged(1, "Pat")
        await service.maintenanceFiled({ requestId: 1, tenantId: 1, unitLabel: "Unit 1A", title: "Leak", description: "" })
        await service.maintenanceUpdated({ requestId: 1, tenantId: 1, title: "Leak", status: "scheduled" })
        await service.paymentReported({ tenantId: 1, unitLabel: "Unit 1A", method: "Zelle", amount: 10 })
        expect(await service.run()).toEqual({ sent: 0, failed: 0, skipped: "email off" })
        expect(db.calls).toEqual([])
    })

    it("emails once per unread burst, and links to the conversation", async () => {
        let unread = 1
        const { sender, sent } = fakeSender()
        const service = new NotificationService(fakeStore({ countUnreadFrom: async () => unread }), sender, OPTIONS)
        await service.tenantMessaged(7)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ to: "pat@office.test", subject: "New message from Lee Renter" })
        expect(sent[0]!.text).toContain("https://portal.example.com/#/messages/7")
        unread = 2
        await service.tenantMessaged(7)
        expect(sent).toHaveLength(1)
    })

    it("never fails the request it came from, even when the database or Resend does", async () => {
        const broken = fakeStore({ countUnreadFrom: async () => { throw new Error("db down") } })
        const failing: EmailSender = { async send() { throw new Error("Resend answered 500") } }
        await expect(new NotificationService(broken, failing, OPTIONS).tenantMessaged(1)).resolves.toBeUndefined()
        await expect(new NotificationService(fakeStore(), failing, OPTIONS).officeMessaged(1, null)).resolves.toBeUndefined()
    })

    it("marks a notice email sent or failed, with the reason", async () => {
        const finished: Array<[number, boolean, string | null]> = []
        const db = fakeStore({
            claimNoticeEmails: async () => [
                { id: 1, tenantId: 5, name: "Lee", email: "lee@home.test", template: "manual", subject: "Pool closed", body: "Repairs." },
                { id: 2, tenantId: 6, name: "Kim", email: "kim@home.test", template: "manual", subject: "Pool closed", body: "Repairs." },
            ],
            finishNoticeEmail: async (id, ok, error) => { finished.push([id, ok, error]) },
        })
        const sender: EmailSender = { async send(email) { if (email.to === "kim@home.test") throw new Error("Resend answered 422: bad address") } }
        expect(await new NotificationService(db, sender, OPTIONS).deliverNotices()).toEqual({ sent: 1, failed: 1 })
        expect(finished).toEqual([[1, true, null], [2, false, "Resend answered 422: bad address"]])
    })
})
