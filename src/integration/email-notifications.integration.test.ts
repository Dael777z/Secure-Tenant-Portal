// Email notifications (011) on the full sample, with a fake Resend: the office's and the
// tenants' own choices (006, 008), event emails from real requests, notice emails through the
// queue (receipts, rent reminders, the office's notices), the office's daily emails, and the
// database functions answering only 'system'. Skipped without TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import type { EmailSender, OutgoingEmail } from "../services/email"
import { NotificationService } from "../services/notifications"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"
import { ACCOUNTS, Client, listen } from "./http-client"

const config = loadConfig({ NODE_ENV: "test" })
const OPTIONS = { timeZone: config.timeZone, webOrigin: "https://portal.example.com", leaseEndingNoticeDays: 90 }

/** Resend without the network: what was sent, and addresses that fail. */
function fakeResend() {
    const sent: OutgoingEmail[] = []
    const failFor = new Set<string>()
    const sender: EmailSender = {
        async send(email) {
            if (failFor.has(email.to)) throw new Error("Resend answered 422: invalid recipient")
            sent.push(email)
        },
    }
    return { sender, sent, failFor }
}

/** Wait for something a request set off in the background. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 5000) {
    const until = Date.now() + ms
    while (!(await check())) {
        if (Date.now() > until) throw new Error("timed out waiting")
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

describe.skipIf(!hasDatabase)("email notifications through Resend (011)", () => {
    let t: TestDatabase
    let container: Container
    let app: Awaited<ReturnType<typeof listen>>
    const resend = fakeResend()
    let managers: string[]
    let tenantId: number
    let leaseId: number

    const one = async <T>(sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows[0] as T
    const signIn = (who: { email: string; password: string }) => new Client(app.host, config.webOrigin).signIn(who)
    /** Emails sent from here on. */
    const mark = () => {
        const from = resend.sent.length
        return () => resend.sent.slice(from)
    }
    /** The notifications with a chosen send-from hour (0: rent reminders go now; 24: never today). */
    const notifications = (sendFromHour: number) => new NotificationService(t.db, resend.sender, { ...OPTIONS, sendFromHour })
    const officeSettings = (office: Client, over: Record<string, unknown> = {}) => office.put("/api/manager/settings/notifications", {
        notifyEmail: null, newMaintenance: true, tenantMessage: true, reportedPayment: true, lateRent: true, ...over,
    })
    const tenantPrefs = (c: Client, over: Record<string, boolean> = {}) =>
        c.put("/api/tenant/notifications", { rentDue: true, paymentReceipts: true, maintenance: true, messages: true, ...over })

    beforeAll(async () => {
        t = await freshDatabase("it_email")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null, stripe: null, email: resend.sender })
        app = await listen(createApp(container))
        managers = (await t.owner.query(
            "SELECT email::text FROM Admin WHERE role = 'admin' AND deactivated_at IS NULL AND signup_completed ORDER BY email")).rows.map((r) => r.email)
        tenantId = (await one<{ tid: number }>("SELECT tID AS tid FROM Tenants WHERE Email = 'tenant@example.com'")).tid
        leaseId = (await one<{ id: number }>(
            "SELECT l.LeaseID AS id FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID WHERE lt.tID = $1 ORDER BY l.start_date DESC LIMIT 1", [tenantId])).id
        // The sample's own notices (its payments' receipts, its reminders) are history, not news to email.
        await t.owner.query("UPDATE Notifications_Sent SET created_at = created_at - interval '3 days'")
    })
    afterAll(async () => {
        await app?.close()
        await container?.close()
        await t?.drop()
    })

    it("a tenant's message reaches every property manager once per unread burst, or the office's own address once set", async () => {
        expect(managers.length).toBeGreaterThan(0)
        const tenant = await signIn(ACCOUNTS.tenant)
        const office = await signIn(ACCOUNTS.admin)
        await office.post(`/api/manager/messages/${tenantId}/read`)   // the sample's own messages, opened
        let sent = mark()
        expect((await tenant.post("/api/tenant/messages", { body: "The hallway light is out." })).status).toBe(201)
        await eventually(() => sent().length === managers.length)
        expect(sent().map((e) => e.to).sort()).toEqual(managers)
        expect(sent()[0]).toMatchObject({ subject: "New message from Test Tenant" })
        expect(sent()[0]!.text).not.toContain("hallway")   // message bodies are never emailed
        expect(sent()[0]!.text).toContain(`/#/messages/${tenantId}`)

        // A second message the office has not opened yet: no second email.
        sent = mark()
        await tenant.post("/api/tenant/messages", { body: "Also the stairwell." })
        await container.notifications.tenantMessaged(tenantId)
        expect(sent()).toEqual([])

        // The office sends its notifications to one address, and turns new-maintenance emails off.
        expect((await officeSettings(office, { notifyEmail: "office@summit.test", newMaintenance: false })).status).toBe(200)
        await office.post(`/api/manager/messages/${tenantId}/read`)
        sent = mark()
        await tenant.post("/api/tenant/messages", { body: "Thanks!" })
        await eventually(() => sent().length === 1)
        expect(sent()[0]!.to).toBe("office@summit.test")

        sent = mark()
        expect((await tenant.post("/api/tenant/maintenance", { title: "Window stuck", description: "Bedroom window will not open." })).status).toBe(201)
        await container.notifications.maintenanceFiled({ requestId: 1, tenantId, unitLabel: "Unit", title: "x", description: "" })
        expect(sent()).toEqual([])   // turned off
        await officeSettings(office)
    })

    it("a new maintenance request and a reported Cash App / Zelle payment tell the office", async () => {
        const tenant = await signIn(ACCOUNTS.tenant)
        let sent = mark()
        const filed = await tenant.post("/api/tenant/maintenance", { title: "Oven not heating", description: "Category: appliance | Urgency: soon | It stays cold." })
        expect(filed.status).toBe(201)
        await eventually(() => sent().length === managers.length)
        expect(sent()[0]).toMatchObject({ subject: "New maintenance request: Oven not heating" })
        expect(sent()[0]!.text).toContain(`/#/maintenance/${filed.body.id.replace("mr_", "")}`)

        // James owes two months; he reports a Zelle payment for it.
        const james = await signIn({ email: "james.johnson@example.com", password: PASSWORDS.tenant })
        const owed = (await james.get("/api/tenant/summary")).body.currentBalance as number
        sent = mark()
        expect((await james.post("/api/tenant/payments/report", { method: "zelle", amount: owed, idempotencyKey: "report-email-0001" })).status).toBe(201)
        await eventually(() => sent().length === managers.length)
        expect(sent()[0]!.subject).toMatch(/^Zelle payment to confirm: .* from James Johnson$/)
    })

    it("a resident hears about office messages and repair updates, unless they turned them off", async () => {
        const tenant = await signIn(ACCOUNTS.tenant)
        const office = await signIn(ACCOUNTS.admin)
        await tenant.post("/api/tenant/messages/read")
        let sent = mark()
        expect((await office.post(`/api/manager/messages/${tenantId}`, { body: "We will fix it Tuesday." })).status).toBe(201)
        await eventually(() => sent().length === 1)
        expect(sent()[0]).toMatchObject({ to: "tenant@example.com", subject: "New message from the property office" })
        expect(sent()[0]!.text).not.toContain("Tuesday")

        const request = Number((await tenant.post("/api/tenant/maintenance", { title: "Leaky shower", description: "Drips all night." })).body.id.replace("mr_", ""))
        sent = mark()
        expect((await office.put(`/api/manager/maintenance/${request}`, { status: "scheduled" })).status).toBe(200)
        await eventually(() => sent().some((e) => e.to === "tenant@example.com"))
        expect(sent().find((e) => e.to === "tenant@example.com")).toMatchObject({ subject: "Maintenance update: Leaky shower (Scheduled)" })

        // Changing only the priority is not a new stage: no email.
        sent = mark()
        await office.put(`/api/manager/maintenance/${request}`, { priority: "high" })
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(sent().filter((e) => e.to === "tenant@example.com")).toEqual([])

        // Turned off in Settings: neither comes.
        expect((await tenantPrefs(tenant, { messages: false, maintenance: false })).status).toBe(200)
        sent = mark()
        await tenant.post("/api/tenant/messages/read")
        await office.post(`/api/manager/messages/${tenantId}`, { body: "Update: Wednesday." })
        await office.put(`/api/manager/maintenance/${request}`, { status: "in_progress" })
        await container.notifications.officeMessaged(tenantId, null)
        await container.notifications.maintenanceUpdated({ requestId: request, tenantId, title: "Leaky shower", status: "resolved" })
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(sent().filter((e) => e.to === "tenant@example.com")).toEqual([])
        await tenantPrefs(tenant)
    })

    it("payment receipts are emailed beside the in-app notice, once; a send that fails says why", async () => {
        const residents = (await t.owner.query("SELECT t.Email::text AS email FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID WHERE lt.LeaseID = $1", [leaseId])).rows.map((r) => r.email)
        // A completed payment: 009's trigger writes the in-app "Payment received" notice.
        await t.owner.query("INSERT INTO Payment (LeaseID, amount, status, transaction_id) VALUES ($1, 25, 'completed', 'txn-email-receipt')", [leaseId])
        const sent = mark()
        const first = await notifications(24).deliverNotices()
        expect(first).toEqual({ sent: residents.length, failed: 0 })
        expect(sent().map((e) => e.to).sort()).toEqual([...residents].sort())
        expect(sent()[0]).toMatchObject({ subject: "Payment received: $25.00" })
        expect(sent()[0]!.idempotencyKey).toMatch(/^notice:\d+$/)

        // The email is its own row beside the in-app notice: same notice, so the Notices page shows them together.
        const rows = (await t.owner.query(
            `SELECT n.channel, n.status, n.sent_at IS NOT NULL AS sent, n.email_of = i.notID AS twin, n.created_at = i.created_at AS same_time
             FROM Notifications_Sent i JOIN Notifications_Sent n ON n.notID = i.notID OR n.email_of = i.notID
             JOIN Payment p ON p.payID = i.source_payment
             WHERE p.transaction_id = 'txn-email-receipt' AND i.channel = 'in_app' AND i.tID = $1 ORDER BY n.notID`, [tenantId])).rows
        expect(rows).toEqual([
            { channel: "in_app", status: "sent", sent: true, twin: null, same_time: true },
            { channel: "email", status: "sent", sent: true, twin: true, same_time: true },
        ])
        // Nothing twice.
        expect(await notifications(24).deliverNotices()).toEqual({ sent: 0, failed: 0 })

        // Resend refuses an address: the row says so.
        resend.failFor.add("tenant@example.com")
        await t.owner.query("INSERT INTO Payment (LeaseID, amount, status, transaction_id) VALUES ($1, 5, 'completed', 'txn-email-fail')", [leaseId])
        expect((await notifications(24).deliverNotices()).failed).toBe(1)
        resend.failFor.clear()
        expect(await one(
            `SELECT n.status, n.error FROM Notifications_Sent n JOIN Notifications_Sent i ON i.notID = n.email_of JOIN Payment p ON p.payID = i.source_payment
             WHERE p.transaction_id = 'txn-email-fail' AND n.tID = $1`, [tenantId])).toEqual({ status: "failed", error: "Resend answered 422: invalid recipient" })
    })

    it("rent reminders wait for the morning, follow the resident's choice, and stale ones are not sent late", async () => {
        const tenant = await signIn(ACCOUNTS.tenant)
        const charge = (await one<{ id: number; due: string }>("SELECT chargeID AS id, due_date::text AS due FROM Charge WHERE LeaseID = $1 AND kind = 'rent' ORDER BY due_date DESC LIMIT 1", [leaseId]))
        const remind = (kind: string, sentOn: string) => t.owner.query(
            "INSERT INTO Rent_Reminders_Sent (LeaseID, chargeID, kind, due_date, amount, sent_on) VALUES ($1, $2, $3, $4, 950, $5)", [leaseId, charge.id, kind, charge.due, sentOn])
        await remind("overdue", "2099-01-01")

        let sent = mark()
        await notifications(24).deliverNotices()   // before the send-from hour
        expect(sent().filter((e) => e.subject === "Rent is past due")).toEqual([])
        await notifications(0).deliverNotices()    // after it
        expect(sent().filter((e) => e.subject === "Rent is past due").map((e) => e.to)).toContain("tenant@example.com")

        // Turned off: the email row is there, skipped, and says why.
        await tenantPrefs(tenant, { rentDue: false })
        await remind("overdue", "2099-01-02")
        sent = mark()
        await notifications(0).deliverNotices()
        expect(sent().filter((e) => e.to === "tenant@example.com")).toEqual([])
        expect(await one(
            `SELECT n.status, n.error FROM Notifications_Sent n JOIN Notifications_Sent i ON i.notID = n.email_of JOIN Rent_Reminders_Sent r ON r.remID = i.source_reminder
             WHERE r.sent_on = '2099-01-02' AND n.tID = $1`, [tenantId])).toEqual({ status: "skipped", error: "The resident turned these emails off in Settings." })
        await tenantPrefs(tenant)

        // Queued, but not sent in time (email was down for days): skipped, not sent late.
        await remind("overdue", "2099-01-03")
        await t.owner.query("UPDATE Notifications_Sent SET created_at = now() - interval '3 days' WHERE source_reminder = (SELECT remID FROM Rent_Reminders_Sent WHERE sent_on = '2099-01-03')")
        await t.owner.query(
            `INSERT INTO Notifications_Sent (tID, LeaseID, channel, template, subject, body, status, created_at, source_reminder, email_of)
             SELECT tID, LeaseID, 'email', template, subject, body, 'queued', created_at, source_reminder, notID FROM Notifications_Sent
             WHERE source_reminder = (SELECT remID FROM Rent_Reminders_Sent WHERE sent_on = '2099-01-03') AND channel = 'in_app'`)
        sent = mark()
        await notifications(0).deliverNotices()
        expect(sent()).toEqual([])
        expect((await t.owner.query(
            "SELECT DISTINCT status FROM Notifications_Sent WHERE channel = 'email' AND source_reminder = (SELECT remID FROM Rent_Reminders_Sent WHERE sent_on = '2099-01-03')")).rows)
            .toEqual([{ status: "skipped" }])
    })

    it("the office gets one late-rent summary a day and hears about each ending lease once; turned off, no summary", async () => {
        const service = notifications(0)
        const sent = mark()
        const first = await service.runOfficeEmails()
        expect(first.failed).toBe(0)
        const late = sent().filter((e) => e.subject.startsWith("Late rent:"))
        expect(late.map((e) => e.to).sort()).toEqual(managers)
        expect(late[0]!.text).toContain("James Johnson")
        expect(sent().some((e) => e.subject.startsWith("Lease ending "))).toBe(true)   // James's lease ends within 90 days

        const again = mark()
        expect(await service.runOfficeEmails()).toEqual({ sent: 0, failed: 0 })
        expect(again()).toEqual([])
        expect(await notifications(24).runOfficeEmails()).toEqual({ sent: 0, failed: 0 })   // and nothing before the morning

        // Tomorrow's summary, with late rent turned off: none.
        const office = await signIn(ACCOUNTS.admin)
        await officeSettings(office, { lateRent: false })
        const tomorrow = mark()
        await service.runOfficeEmails(new Date(Date.now() + 24 * 60 * 60 * 1000))
        expect(tomorrow().filter((e) => e.subject.startsWith("Late rent:"))).toEqual([])
        await officeSettings(office)
    })

    it("the office's notices go by email when ticked, except to residents who turned them off", async () => {
        const office = await signIn(ACCOUNTS.admin)
        expect((await office.get("/api/manager/notices")).body.emailEnabled).toBe(true)
        const tenant = await signIn(ACCOUNTS.tenant)

        const sent = mark()
        const notice = await office.post("/api/manager/notices", { audience: { kind: "tenant", id: tenantId }, subject: "Water off Friday", body: "From 9 to 11.", email: true })
        expect(notice).toMatchObject({ status: 201, body: { recipients: 1, emailsQueued: 1, emailsSkipped: 0 } })
        await eventually(() => sent().some((e) => e.subject === "Water off Friday"))   // sent at once, not on the next minute
        expect(sent().find((e) => e.subject === "Water off Friday")).toMatchObject({ to: "tenant@example.com" })
        await eventually(async () => (await office.get("/api/manager/notices?channel=email&q=Water")).body.notices[0]?.status === "sent")

        await tenantPrefs(tenant, { messages: false })
        const skipped = await office.post("/api/manager/notices", { audience: { kind: "tenant", id: tenantId }, subject: "Pool closed", body: "Repairs.", email: true })
        expect(skipped.body).toMatchObject({ recipients: 1, emailsQueued: 0, emailsSkipped: 1 })
        const inApp = await office.post("/api/manager/notices", { audience: { kind: "tenant", id: tenantId }, subject: "Portal only", body: "No email." })
        expect(inApp.body).toMatchObject({ recipients: 1, emailsQueued: 0, emailsSkipped: 0 })
        expect((await office.post("/api/manager/notices", { audience: { kind: "all" }, subject: "x", body: "y", email: "yes" })).status).toBe(400)
        await tenantPrefs(tenant)
    })

    it("the notify and queue functions answer nobody but 'system'", async () => {
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'tenant', true), set_config('app.user_id', $1, true)", [String(tenantId)])
            expect((await client.query("SELECT * FROM notify_office('message')")).rowCount).toBe(0)
            expect((await client.query("SELECT * FROM notify_tenant($1, NULL)", [tenantId])).rowCount).toBe(0)
            expect((await client.query("SELECT * FROM notify_past_due(current_date)")).rowCount).toBe(0)
            expect((await client.query("SELECT tenant_wants_email($1, 'messages') AS w", [tenantId])).rows[0].w).toBeNull()
            expect((await client.query("SELECT queue_notice_emails(now() - interval '30 days', ARRAY['payment_received']) AS n")).rows[0].n).toBe(0)
            expect((await client.query("SELECT * FROM claim_notice_emails(10, now() - interval '30 days')")).rowCount).toBe(0)
            expect((await client.query("SELECT count(*)::int AS n FROM Scheduled_Emails_Sent")).rows[0].n).toBe(0)
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    })

    it("without Resend keys nothing is emailed or queued, and the office's notices stay in the portal", async () => {
        const quiet = createContainer({ config, db: t.db, plaid: null, stripe: null, email: null })
        const server = await listen(createApp(quiet))
        try {
            expect(quiet.notifications.enabled).toBe(false)
            expect(await quiet.notifications.run()).toEqual({ sent: 0, failed: 0, skipped: "email off" })
            const office = await new Client(server.host, config.webOrigin).signIn(ACCOUNTS.admin)
            expect((await office.get("/api/manager/notices")).body.emailEnabled).toBe(false)
            const notice = await office.post("/api/manager/notices", { audience: { kind: "tenant", id: tenantId }, subject: "No email here", body: "Portal.", email: true })
            expect(notice.body).toMatchObject({ recipients: 1, emailsQueued: 0, emailsSkipped: 0 })
            expect((await t.owner.query("SELECT count(*)::int AS n FROM Notifications_Sent WHERE subject = 'No email here' AND channel = 'email'")).rows[0].n).toBe(0)
        } finally {
            await server.close()
            await quiet.close()
        }
    })
})
