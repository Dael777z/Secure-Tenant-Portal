import { silentLogger, type LogService } from "../logging"
import type { Recipient } from "../types/records"
import type { NotificationStore } from "../types/stores"
import type { EmailSender, OutgoingEmail } from "./email"
import {
    lateRentEmail, leaseEndingEmail, maintenanceEmail, maintenanceUpdateEmail, noticeEmail, officeMessageEmail, reportedPaymentEmail,
    tenantMessageEmail, type EmailContent,
} from "./email-templates"
import { localDate } from "./ledger"

/**
 * Email notifications (011), sent through Resend. Everyone's choices are the ones the
 * portal already keeps: each tenant's (Settings, 006) and the office's (Settings →
 * Notifications, 008: where to send, and which topics).
 *
 *   to a resident    their notices (009) by email: rent reminders (the office's reminder
 *                    rules, 008), payment receipts, and notices the office sends with "email"
 *                    ticked; a message from the office; a repair moving to a new stage
 *   to the office    a tenant's message, a new maintenance request, a Cash App / Zelle
 *                    payment to confirm, one late-rent summary a day, a lease ending soon
 *
 * Notice emails go through a queue in Notifications_Sent (an 'email' row beside each
 * in-app notice), so the office sees each one's status on the Notices page. Rent
 * reminders wait until `sendFromHour`; receipts and the office's notices go at once.
 *
 * The event emails (messages, maintenance, reported payments) start from a request and
 * never hold it up or fail it: they run after it, and a failure is only logged. A burst
 * of messages makes one email: only the first one the other side has not opened sends one.
 *
 * Without a sender (RESEND_API_KEY unset) nothing is sent, queued or recorded.
 */
export interface NotificationOptions {
    timeZone: string
    /** Links in the emails start here. */
    webOrigin: string
    sendFromHour: number
    leaseEndingNoticeDays: number
}

export interface DeliveryResult {
    sent: number
    failed: number
    skipped?: "email off"
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Notices of these kinds are emailed as they appear. */
const AT_ONCE = ["payment_received"]
/** Rent reminders: written by the night's job, emailed from sendFromHour. */
const RENT_REMINDERS = ["rent_upcoming", "rent_due", "rent_overdue"]
/** A queued notice older than this is skipped, not sent late. */
const TOO_OLD_MS = 2 * DAY_MS
/** How many queued notice emails one pass sends. */
const BATCH = 50

export class NotificationService {
    private timer: NodeJS.Timeout | null = null
    private running = false
    private lastScheduled = 0

    constructor(
        private readonly db: NotificationStore,
        private readonly sender: EmailSender | null,
        private readonly options: NotificationOptions,
        private readonly logger: LogService = silentLogger,
    ) {}

    get enabled(): boolean {
        return this.sender !== null
    }

    private url(path = "/"): string {
        return `${this.options.webOrigin.replace(/\/$/, "")}${path}`
    }

    // ---- Event emails: callers `void` these; they never reject

    /** A tenant wrote to the office: the office hears, once per unread burst. */
    tenantMessaged(tID: number): Promise<void> {
        return this.background("notify.tenant_message", { tenantId: tID }, async () => {
            if ((await this.db.countUnreadFrom(tID, false)) !== 1) return 0
            const [tenant, office] = await Promise.all([this.db.findTenantRecipient(tID, null), this.db.listOfficeRecipients("message")])
            if (!tenant) return 0
            return this.sendAll(office.map((to) => this.email(to, tenantMessageEmail({
                managerName: to.name, tenantName: tenant.name, url: this.url(`/#/messages/${tID}`),
            }))))
        })
    }

    /** The office wrote to a tenant: the tenant hears (unless they turned it off), once per unread burst. */
    officeMessaged(tID: number, senderName: string | null): Promise<void> {
        return this.background("notify.office_message", { tenantId: tID }, async () => {
            if ((await this.db.countUnreadFrom(tID, true)) !== 1) return 0
            const tenant = await this.db.findTenantRecipient(tID, "messages")
            if (!tenant) return 0
            return this.sendAll([this.email(tenant, officeMessageEmail({ name: tenant.name, senderName, portalUrl: this.url() }))])
        })
    }

    /** A tenant filed a maintenance request: the office hears, if it wants to. */
    maintenanceFiled(input: { requestId: number; tenantId: number; unitLabel: string; title: string; description: string }): Promise<void> {
        return this.background("notify.maintenance", { requestId: input.requestId }, async () => {
            const office = await this.db.listOfficeRecipients("maintenance")
            if (!office.length) return 0
            const tenant = await this.db.findTenantRecipient(input.tenantId, null)
            return this.sendAll(office.map((to) => this.email(to, maintenanceEmail({
                managerName: to.name, tenantName: tenant?.name ?? "A resident", unitLabel: input.unitLabel,
                title: input.title, description: input.description, url: this.url(`/#/maintenance/${input.requestId}`),
            }))))
        })
    }

    /** A request the tenant filed moved to a new stage: they hear, unless they turned it off. */
    maintenanceUpdated(input: { requestId: number; tenantId: number; title: string; status: string }): Promise<void> {
        return this.background("notify.maintenance_update", { requestId: input.requestId, status: input.status }, async () => {
            const tenant = await this.db.findTenantRecipient(input.tenantId, "maintenance")
            if (!tenant) return 0
            return this.sendAll([this.email(tenant, maintenanceUpdateEmail({ name: tenant.name, title: input.title, status: input.status, portalUrl: this.url() }))])
        })
    }

    /** A tenant reported a Cash App / Zelle payment: the office hears, so someone confirms it. */
    paymentReported(input: { tenantId: number; unitLabel: string; method: string; amount: number }): Promise<void> {
        return this.background("notify.reported_payment", { tenantId: input.tenantId }, async () => {
            const office = await this.db.listOfficeRecipients("reported_payment")
            if (!office.length) return 0
            const tenant = await this.db.findTenantRecipient(input.tenantId, null)
            return this.sendAll(office.map((to) => this.email(to, reportedPaymentEmail({
                managerName: to.name, tenantName: tenant?.name ?? "A resident", unitLabel: input.unitLabel,
                method: input.method, amount: input.amount, url: this.url("/#/"),
            }))))
        })
    }

    // ---- Notice emails (the queue) and the office's daily emails

    /** Queue and send whatever is due. Safe to repeat; `start` runs it every minute. */
    async run(now = new Date()): Promise<DeliveryResult> {
        if (!this.sender) return { sent: 0, failed: 0, skipped: "email off" }
        const notices = await this.deliverNotices(now)
        // The office's daily emails: checked every 15 minutes (each goes out once).
        if (now.getTime() - this.lastScheduled >= 15 * MINUTE_MS) {
            this.lastScheduled = now.getTime()
            const office = await this.runOfficeEmails(now)
            return { sent: notices.sent + office.sent, failed: notices.failed + office.failed }
        }
        return notices
    }

    /** Give new notices their email, then send the queued ones. */
    // logs notify.notices.succeeded { queued, sent, failed } (only when there was something to do)
    async deliverNotices(now = new Date()): Promise<DeliveryResult> {
        if (!this.sender) return { sent: 0, failed: 0, skipped: "email off" }
        // Receipts from the last hour (the queue runs every minute; an hour covers a restart).
        let queued = await this.db.queueNoticeEmails(AT_ONCE, { at: new Date(now.getTime() - HOUR_MS) })
        // Today's rent reminders, once it is late enough in the morning to send them.
        if (localHour(now, this.options.timeZone) >= this.options.sendFromHour) {
            queued += await this.db.queueNoticeEmails(RENT_REMINDERS, { day: localDate(now, this.options.timeZone), timeZone: this.options.timeZone })
        }
        const batch = await this.db.claimNoticeEmails(BATCH, new Date(now.getTime() - TOO_OLD_MS))
        if (!queued && !batch.length) return { sent: 0, failed: 0 }
        return this.logger.flow("notify.notices", { queued }, async () => {
            let sent = 0
            let failed = 0
            for (const notice of batch) {
                try {
                    await this.sender!.send({
                        ...this.email(notice, noticeEmail({ name: notice.name, subject: notice.subject, body: notice.body, portalUrl: this.url() })),
                        idempotencyKey: `notice:${notice.id}`,
                    })
                    await this.db.finishNoticeEmail(notice.id, true, null)
                    sent++
                } catch (error) {
                    failed++
                    this.logger.errorWithCause("email.failed", error, { noticeId: notice.id })
                    await this.db.finishNoticeEmail(notice.id, false, (error as Error).message)
                }
            }
            return { sent, failed }
        }, (result) => ({ ...result }))
    }

    /** One late-rent summary a day, and each lease ending soon once. From sendFromHour, local time. */
    // logs notify.office_daily.succeeded { today, sent, failed } (only when something was due)
    async runOfficeEmails(now = new Date()): Promise<DeliveryResult> {
        if (!this.sender) return { sent: 0, failed: 0, skipped: "email off" }
        if (localHour(now, this.options.timeZone) < this.options.sendFromHour) return { sent: 0, failed: 0 }
        const today = localDate(now, this.options.timeZone)
        const planned = [...(await this.planLateRent(today)), ...(await this.planLeasesEnding(today))]
        const already = await this.db.findScheduledEmailsSent(planned.map((p) => p.key))
        const due = planned.filter((p) => !already.has(p.key))
        if (!due.length) return { sent: 0, failed: 0 }
        return this.logger.flow("notify.office_daily", { today }, async () => {
            let sent = 0
            let failed = 0
            for (const { key, emails } of due) {
                const failures = await this.sendAll(emails.map((e) => ({ ...e, idempotencyKey: `${key}:${e.to}` })), key)
                sent += emails.length - failures
                failed += failures
                // Partly sent: try again later; Resend's idempotency key drops the ones that went out.
                if (failures === 0) await this.db.markScheduledEmailSent(key)
            }
            return { sent, failed }
        }, (result) => ({ ...result }))
    }

    private async planLateRent(today: string): Promise<Planned[]> {
        const late = await this.db.listPastDue(today)
        if (!late.length) return []
        const office = await this.db.listOfficeRecipients("late_rent")
        if (!office.length) return []
        return [{
            key: `late_rent:${today}`,
            emails: office.map((to) => this.email(to, lateRentEmail({ managerName: to.name, today, leases: late, url: this.url("/#/rent-roll?status=owing") }))),
        }]
    }

    private async planLeasesEnding(today: string): Promise<Planned[]> {
        const leases = await this.db.listLeasesEnding(today, this.options.leaseEndingNoticeDays)
        if (!leases.length) return []
        const office = await this.db.listOfficeRecipients("lease_ending")
        return leases.map((lease) => ({
            key: `lease_ending:${lease.leaseId}:${lease.endDate}`,
            emails: office.map((to) => this.email(to, leaseEndingEmail({
                managerName: to.name, unitLabel: lease.unitLabel, tenantNames: lease.tenantNames, endDate: lease.endDate,
                daysLeft: daysBetween(today, lease.endDate), url: this.url(`/#/leases/${lease.leaseId}`),
            }))),
        }))
    }

    /** Send queued notice emails now (the office just sent a notice), without waiting for the next minute. */
    deliverSoon(): void {
        if (!this.sender) return
        void this.tick()
    }

    start(intervalMs = MINUTE_MS): void {
        if (this.timer || !this.sender) return
        void this.tick()
        this.timer = setInterval(() => void this.tick(), intervalMs)
        this.timer.unref()   // never keeps the process alive
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    private async tick(): Promise<void> {
        if (this.running) return
        this.running = true
        try { await this.run() } catch { /* already logged; the next tick tries again */ } finally { this.running = false }
    }

    // ---- Sending

    private email(to: Recipient, content: EmailContent): OutgoingEmail {
        return { to: to.email, ...content }
    }

    /** Send each one; returns how many failed (each logged by key: no address, and no subject, which can name a tenant). */
    private async sendAll(emails: OutgoingEmail[], key?: string): Promise<number> {
        let failures = 0
        for (const email of emails) {
            try {
                await this.sender!.send(email)
            } catch (error) {
                failures++
                this.logger.errorWithCause("email.failed", error, { key })
            }
        }
        return failures
    }

    /** Run after the request, log how it went, never throw. */
    private async background(event: string, metadata: Record<string, unknown>, work: () => Promise<number>): Promise<void> {
        if (!this.sender) return
        try {
            await this.logger.flow(event, metadata, work, (failed) => ({ failed }))
        } catch {
            // logged by flow; an email is never worth failing the request it came from
        }
    }
}

type Planned = { key: string; emails: OutgoingEmail[] }

function localHour(now: Date, timeZone: string): number {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now))
}

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}
