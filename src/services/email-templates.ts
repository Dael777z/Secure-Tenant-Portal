/**
 * The notification emails: a subject, an HTML body and a plain-text body each.
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

const monthName = (isoDate: string) =>
    new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })

/** Paragraphs are plain text (escaped here); `button` links to the portal. */
function layout(input: { subject: string; greeting: string; paragraphs: string[]; button: { label: string; url: string } }): EmailContent {
    const { subject, greeting, paragraphs, button } = input
    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px">
<tr><td>
<p style="margin:0 0 16px;font-size:16px">${escape(greeting)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escape(p)}</p>`).join("\n")}
<p style="margin:24px 0 8px"><a href="${escape(button.url)}" style="display:inline-block;background:#1f4b99;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px">${escape(button.label)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Secure Tenant Portal. This is an automatic message; replies are not read.</p>
</td></tr></table>
</td></tr></table>
</body></html>`
    const text = [greeting, "", ...paragraphs.flatMap((p) => [p, ""]), `${button.label}: ${button.url}`].join("\n")
    return { subject, html, text }
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

/** One of each email with made-up details, for `npm run db email-test` (src/cli.ts). */
export function sampleEmails(webOrigin: string, today: string): EmailContent[] {
    const url = (path = "/") => `${webOrigin.replace(/\/$/, "")}${path}`
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const sample = { name: "Test Tenant", managerName: "Test Manager", unitLabel: "Unit 101 - Sample Apartments" }
    return [
        rentDueEmail({ ...sample, monthlyRent: 950, balance: 950, today: `${today.slice(0, 8)}01`, portalUrl: url() }),
        pastDueEmail({ ...sample, dueDate: `${today.slice(0, 8)}01`, balance: 950, portalUrl: url() }),
        officeMessageEmail({ name: sample.name, senderName: sample.managerName, portalUrl: url() }),
        tenantMessageEmail({ managerName: sample.managerName, tenantName: sample.name, url: url("/#/messages") }),
        leaseEndingEmail({ ...sample, tenantNames: sample.name, endDate: end, daysLeft: 90, url: url("/#/rent-roll") }),
        maintenanceEmail({ ...sample, tenantName: sample.name, title: "Kitchen sink is leaking", description: "Water pools under the cabinet after running the tap.", url: url("/#/maintenance") }),
    ].map((email) => ({ ...email, subject: `[Test] ${email.subject}` }))
}

// ---- To tenants

export function rentDueEmail(input: { name: string; unitLabel: string; monthlyRent: number; balance: number; today: string; portalUrl: string }): EmailContent {
    const month = monthName(input.today)
    return layout({
        subject: `Your ${month} rent is due`,
        greeting: `Hi ${firstName(input.name)},`,
        paragraphs: [
            `Your rent of ${usd(input.monthlyRent)} for ${input.unitLabel} is due today, ${longDate(input.today)}.`,
            input.balance > 0 ? `Your balance is now ${usd(input.balance)}.` : `Your account has no balance due right now. Thank you!`,
        ],
        button: { label: "Pay rent", url: input.portalUrl },
    })
}

export function pastDueEmail(input: { name: string; unitLabel: string; dueDate: string; balance: number; portalUrl: string }): EmailContent {
    return layout({
        subject: "Your rent payment is past due",
        greeting: `Hi ${firstName(input.name)},`,
        paragraphs: [
            `A payment for ${input.unitLabel} was due on ${longDate(input.dueDate)} and we have not received it yet.`,
            `Your balance is ${usd(input.balance)}. Please pay as soon as you can, or message the office if something is wrong.`,
        ],
        button: { label: "Pay now", url: input.portalUrl },
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

// ---- To property managers

export function tenantMessageEmail(input: { managerName: string; tenantName: string; url: string }): EmailContent {
    return layout({
        subject: `New message from ${input.tenantName}`,
        greeting: `Hi ${firstName(input.managerName)},`,
        paragraphs: [`${input.tenantName} sent the office a message. Sign in to read it and reply.`],
        button: { label: "Open conversation", url: input.url },
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
        button: { label: "View lease", url: input.url },
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
            "You can turn these emails off on the Maintenance page.",
        ],
        button: { label: "Open maintenance queue", url: input.url },
    })
}
