import { silentLogger, type LogService } from "../logging"
import type { Recipient } from "../types/records"
import type { NotificationStore } from "../types/stores"
import type { EmailSender, OutgoingEmail } from "./email"
import {
    leaseEndingEmail, maintenanceEmail, officeMessageEmail, pastDueEmail, rentDueEmail, tenantMessageEmail, type EmailContent,
} from "./email-templates"
import { localDate } from "./ledger"

/**
 * Email notifications (005), sent through Resend.
 *
 *   to a tenant      rent due (the 1st), a bill past due, a message from the office
 *   to the office    a tenant's message, a lease ending within 90 days,
 *                    a tenant's maintenance request (each manager can turn this one off)
 *
 * The event emails (messages, maintenance) start from a request and never hold it
 * up or fail it: they run after it, and a failure is only logged. A burst of messages
 * makes one email: only the first one the other side has not opened sends one.
 *
 * The scheduled ones run every hour (from `sendFromHour`, local time) and are recorded
 * in Notifications_Sent, so each goes out once: rent once a month per tenant, past due
 * once per unpaid bill, lease ending once per lease and end date.
 *
 * Without a sender (RESEND_API_KEY unset) nothing is sent and nothing is recorded.
 */
export interface NotificationOptions {
    timeZone: string
    /** Links in the emails start here. */
    webOrigin: string
    sendFromHour: number
    leaseEndingNoticeDays: number
}

export interface ScheduledRunResult {
    sent: number
    failed: number
    skipped?: "email off" | "too early"
}

type Planned = { key: string; emails: OutgoingEmail[] }

const DAY_MS = 24 * 60 * 60 * 1000

export class NotificationService {
    private timer: NodeJS.Timeout | null = null
    private running = false

    constructor(
        private readonly db: NotificationStore,
        private readonly sender: EmailSender | null,
        private readonly options: NotificationOptions,
        /** Run before the 1st-of-the-month emails, so this month's rent is on the balance. */
        private readonly rentCharges: { run(): Promise<number> } | null = null,
        private readonly logger: LogService = silentLogger,
    ) {}

    get enabled(): boolean {
        return this.sender !== null
    }

    private url(path = "/"): string {
        return `${this.options.webOrigin.replace(/\/$/, "")}${path}`
    }

    // ---- Event emails: callers `void` these; they never reject

    /** A tenant wrote to the office: every property manager hears, once per unread burst. */
    tenantMessaged(tID: number): Promise<void> {
        return this.background("notify.tenant_message", { tenantId: tID }, async () => {
            if ((await this.db.countUnreadFrom(tID, false)) !== 1) return 0
            const [tenant, staff] = await Promise.all([this.db.findTenantRecipient(tID), this.db.listStaffRecipients(false)])
            if (!tenant) return 0
            return this.sendAll(staff.map((manager) => this.email(manager, tenantMessageEmail({
                managerName: manager.name, tenantName: tenant.name, url: this.url(`/#/messages/${tID}`),
            }))))
        })
    }

    /** The office wrote to a tenant: the tenant hears, once per unread burst. */
    officeMessaged(tID: number, senderName: string | null): Promise<void> {
        return this.background("notify.office_message", { tenantId: tID }, async () => {
            if ((await this.db.countUnreadFrom(tID, true)) !== 1) return 0
            const tenant = await this.db.findTenantRecipient(tID)
            if (!tenant) return 0
            return this.sendAll([this.email(tenant, officeMessageEmail({ name: tenant.name, senderName, portalUrl: this.url() }))])
        })
    }

    /** A tenant filed a maintenance request: the property managers who keep these emails on hear. */
    maintenanceFiled(input: { requestId: number; tenantId: number; unitLabel: string; title: string; description: string }): Promise<void> {
        return this.background("notify.maintenance", { requestId: input.requestId }, async () => {
            const [tenant, staff] = await Promise.all([this.db.findTenantRecipient(input.tenantId), this.db.listStaffRecipients(true)])
            return this.sendAll(staff.map((manager) => this.email(manager, maintenanceEmail({
                managerName: manager.name, tenantName: tenant?.name ?? "A resident", unitLabel: input.unitLabel,
                title: input.title, description: input.description, url: this.url("/#/maintenance"),
            }))))
        })
    }

    // ---- Scheduled emails

    /** Send whatever is due and not yet sent. Safe to repeat. */
    async run(now = new Date()): Promise<ScheduledRunResult> {
        if (!this.sender) return { sent: 0, failed: 0, skipped: "email off" }
        if (localHour(now, this.options.timeZone) < this.options.sendFromHour) return { sent: 0, failed: 0, skipped: "too early" }
        const today = localDate(now, this.options.timeZone)
        return this.logger.flow("notify.scheduled", { today }, async () => {
            const planned: Planned[] = [
                ...(await this.planRentDue(today)),
                ...(await this.planPastDue(today)),
                ...(await this.planLeasesEnding(today)),
            ]
            const already = await this.db.findSentNotifications(planned.map((p) => p.key))
            let sent = 0
            let failed = 0
            for (const { key, emails } of planned.filter((p) => !already.has(p.key))) {
                const failures = await this.sendAll(emails.map((e) => ({ ...e, idempotencyKey: `${key}:${e.to}` })), key)
                sent += emails.length - failures
                failed += failures
                // Partly sent: try again next hour; Resend's idempotency key drops the ones that went out.
                if (failures === 0) await this.db.markNotificationSent(key)
            }
            return { sent, failed }
        }, (result) => ({ ...result }))
    }

    private async planRentDue(today: string): Promise<Planned[]> {
        if (!today.endsWith("-01")) return []
        await this.rentCharges?.run().catch(() => undefined)   // logged by the rent job
        const month = today.slice(0, 7)
        return (await this.db.listRentDue(today)).map((row) => ({
            key: `rent_due:${row.tenantId}:${month}`,
            emails: [this.email(row, rentDueEmail({ ...row, today, portalUrl: this.url() }))],
        }))
    }

    private async planPastDue(today: string): Promise<Planned[]> {
        return (await this.db.listPastDue(today)).map((row) => ({
            key: `past_due:${row.tenantId}:${row.chargeId}`,
            emails: [this.email(row, pastDueEmail({ ...row, portalUrl: this.url() }))],
        }))
    }

    private async planLeasesEnding(today: string): Promise<Planned[]> {
        const leases = await this.db.listLeasesEnding(today, this.options.leaseEndingNoticeDays)
        if (!leases.length) return []
        const staff = await this.db.listStaffRecipients(false)
        return leases.map((lease) => ({
            key: `lease_ending:${lease.leaseId}:${lease.endDate}`,
            emails: staff.map((manager) => this.email(manager, leaseEndingEmail({
                managerName: manager.name, unitLabel: lease.unitLabel, tenantNames: lease.tenantNames, endDate: lease.endDate,
                daysLeft: daysBetween(today, lease.endDate), url: this.url(`/#/leases/${lease.leaseId}`),
            }))),
        }))
    }

    start(intervalMs = 60 * 60 * 1000): void {
        if (this.timer || !this.sender) return
        const tick = async () => {
            if (this.running) return
            this.running = true
            try { await this.run() } catch { /* already logged; the next tick tries again */ } finally { this.running = false }
        }
        void tick()
        this.timer = setInterval(tick, intervalMs)
        this.timer.unref()   // never keeps the process alive
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
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

function localHour(now: Date, timeZone: string): number {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now))
}

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}
