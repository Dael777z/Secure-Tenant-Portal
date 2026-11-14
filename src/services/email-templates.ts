/**
 * The notification emails (011): a subject, an HTML body and a plain-text body each.
 * Every value from the database is escaped before it reaches the HTML. Message
 * bodies are never included; the email says there is one and links to the portal.
 */

export interface EmailContent {
    subject: string
    html: string
    text: string
}

const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

export const usd = (amount: number) => amount.toLocaleString("en-US", { style: "currency", currency: "USD" })

/** "2026-11-01" → "November 1, 2026" (a DATE, so no time zone shift). */
export const longDate = (isoDate: string) =>
    new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })

/** Paragraphs are plain text (escaped here); `button` links to the portal. */
function layout(input: { subject: string; greeting: string; paragraphs: string[]; button: { label: string; url: string } }): EmailContent {
    const { subject, greeting, paragraphs, button } = input
    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">
<tr><td>
<p style="margin:0 0 16px;font-size:16px">${escape(greeting)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;white-space:pre-line">${escape(p)}</p>`).join("\n")}
<p style="margin:24px 0 8px"><a href="${escape(button.url)}" style="display:inline-block;background:#2f5d8a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px">${escape(button.label)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Secure Tenant Portal. This is an automatic message; replies are not read.</p>
</td></tr></table>
</td></tr></table>
</body></html>`
    const text = [greeting, "", ...paragraphs.flatMap((p) => [p, ""]), `${button.label}: ${button.url}`].join("\n")
    return { subject, html, text }
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

/** How a maintenance stage reads to a resident (frontend/src/manager/api.ts REQUEST_STATUSES). */
const STAGES: Record<string, string> = {
    submitted: "New", in_review: "In review", scheduled: "Scheduled", in_progress: "In progress", resolved: "Completed", rejected: "Closed",
}

/** One of each email with made-up details, for `npm run db email-test` (src/cli.ts). */
export function sampleEmails(webOrigin: string, today: string): EmailContent[] {
    const url = (path = "/") => `${webOrigin.replace(/\/$/, "")}${path}`
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const first = `${today.slice(0, 8)}01`
    const sample = { name: "Test Tenant", managerName: "Test Manager", unitLabel: "Unit 101 - Sample Apartments" }
    return [
        noticeEmail({ name: sample.name, subject: "Rent is due today", body: `Rent of $950.00 is due today, ${longDate(first)}. You can pay in the resident portal.`, portalUrl: url() }),
        noticeEmail({ name: sample.name, subject: "Payment received: $950.00", body: `We received your payment of $950.00 on ${longDate(today)}. Thank you. Your receipt is in the resident portal.`, portalUrl: url() }),
        officeMessageEmail({ name: sample.name, senderName: sample.managerName, portalUrl: url() }),
        maintenanceUpdateEmail({ name: sample.name, title: "Kitchen sink is leaking", status: "scheduled", portalUrl: url() }),
        tenantMessageEmail({ managerName: sample.managerName, tenantName: sample.name, url: url("/#/messages") }),
        maintenanceEmail({ ...sample, tenantName: sample.name, title: "Kitchen sink is leaking", description: "Water pools under the cabinet after running the tap.", url: url("/#/maintenance") }),
        reportedPaymentEmail({ managerName: sample.managerName, tenantName: sample.name, unitLabel: sample.unitLabel, method: "Zelle", amount: 950, url: url("/#/") }),
        lateRentEmail({ managerName: sample.managerName, today, leases: [{ unitLabel: sample.unitLabel, tenantNames: sample.name, dueDate: first, balance: 950 }], url: url("/#/rent-roll?status=owing") }),
        leaseEndingEmail({ ...sample, tenantNames: sample.name, endDate: end, daysLeft: 90, url: url("/#/renewals?days=90") }),
    ].map((email) => ({ ...email, subject: `[Test] ${email.subject}` }))
}

// ---- To residents

/** A notice the resident also has in the portal (009): a rent reminder, a payment receipt, or one the office wrote. */
export function noticeEmail(input: { name: string; subject: string; body: string; portalUrl: string }): EmailContent {
    return layout({
        subject: input.subject,
        greeting: `Hi ${firstName(input.name)},`,
        paragraphs: [input.body],
        button: { label: "Open the resident portal", url: input.portalUrl },
    })
}

export function officeMessageEmail(input: { name: string; senderName: string | null; portalUrl: string }): EmailContent {
    const from = input.senderName ? `${input.senderName} from the property office` : "The property office"
    return layout({
        subject: "New message from the property office",
        greeting: `Hi ${firstName(input.name)},`,
        paragraphs: [`${from} sent you a message. Sign in to the portal to read it and reply.`],
        button: { label: "Read message", url: input.portalUrl },
    })
}

export function maintenanceUpdateEmail(input: { name: string; title: string; status: string; portalUrl: string }): EmailContent {
    const stage = STAGES[input.status] ?? input.status
    const line =
        input.status === "resolved" ? `Your maintenance request "${input.title}" is complete. If the problem comes back, file a new request in the portal.`
            : input.status === "rejected" ? `Your maintenance request "${input.title}" was closed by the office. Message the office in the portal if you have questions.`
                : `Your maintenance request "${input.title}" is now: ${stage}.`
    return layout({
        subject: `Maintenance update: ${input.title} (${stage})`,
        greeting: `Hi ${firstName(input.name)},`,
        paragraphs: [line],
        button: { label: "View your requests", url: input.portalUrl },
    })
}

// ---- To the office

const officeFooter = "The office can choose these emails, and where they go, in Settings → Notifications."

export function tenantMessageEmail(input: { managerName: string; tenantName: string; url: string }): EmailContent {
    return layout({
        subject: `New message from ${input.tenantName}`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [`${input.tenantName} sent the office a message. Sign in to read it and reply.`, officeFooter],
        button: { label: "Open conversation", url: input.url },
    })
}

export function maintenanceEmail(input: { managerName: string; tenantName: string; unitLabel: string; title: string; description: string; url: string }): EmailContent {
    const description = input.description.length > 500 ? `${input.description.slice(0, 500)}…` : input.description
    return layout({
        subject: `New maintenance request: ${input.title}`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [
            `${input.tenantName} filed a maintenance request for ${input.unitLabel}: "${input.title}".`,
            ...(description ? [description] : []),
            officeFooter,
        ],
        button: { label: "Open the request", url: input.url },
    })
}

export function reportedPaymentEmail(input: { managerName: string; tenantName: string; unitLabel: string; method: string; amount: number; url: string }): EmailContent {
    return layout({
        subject: `${input.method} payment to confirm: ${usd(input.amount)} from ${input.tenantName}`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [
            `${input.tenantName} (${input.unitLabel}) says they sent ${usd(input.amount)} by ${input.method}.`,
            `Check the office's ${input.method} account, then confirm the payment (or reject it) in the portal. It is not on their ledger until you do.`,
            officeFooter,
        ],
        button: { label: "Review the payment", url: input.url },
    })
}

export function lateRentEmail(input: {
    managerName: string; today: string; leases: Array<{ unitLabel: string; tenantNames: string; dueDate: string; balance: number }>; url: string
}): EmailContent {
    const total = input.leases.reduce((sum, l) => sum + l.balance, 0)
    const shown = input.leases.slice(0, 25)
    const lines = shown.map((l) => `• ${l.unitLabel}${l.tenantNames ? ` (${l.tenantNames})` : ""}: ${usd(l.balance)}, unpaid since ${longDate(l.dueDate)}`)
    if (input.leases.length > shown.length) lines.push(`…and ${input.leases.length - shown.length} more.`)
    const leases = input.leases.length === 1 ? "1 lease" : `${input.leases.length} leases`
    const count = `${leases} ${input.leases.length === 1 ? "is" : "are"}`
    return layout({
        subject: `Late rent: ${leases} behind (${usd(total)})`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [`As of ${longDate(input.today)}, ${count} behind on rent, ${usd(total)} in all:`, lines.join("\n"), officeFooter],
        button: { label: "Open the rent roll", url: input.url },
    })
}

export function leaseEndingEmail(input: { managerName: string; unitLabel: string; tenantNames: string; endDate: string; daysLeft: number; url: string }): EmailContent {
    const who = input.tenantNames ? ` (${input.tenantNames})` : ""
    return layout({
        subject: `Lease ending ${longDate(input.endDate)}: ${input.unitLabel}`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [
            `The lease for ${input.unitLabel}${who} ends on ${longDate(input.endDate)}, ${input.daysLeft === 1 ? "1 day" : `${input.daysLeft} days`} from now.`,
            "Now is a good time to offer a renewal or plan the move-out.",
        ],
        button: { label: "View lease renewals", url: input.url },
    })
}
