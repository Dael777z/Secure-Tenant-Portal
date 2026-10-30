import { createHash } from "node:crypto"

import { silentLogger, type LogService } from "../logging"

/** One email to one person. `idempotencyKey`: Resend drops a repeat with the same key (for 24 hours). */
export interface OutgoingEmail {
    to: string
    subject: string
    html: string
    text: string
    idempotencyKey?: string
}

/** Sends email. Null in the container when RESEND_API_KEY / EMAIL_FROM are not set. */
export interface EmailSender {
    send(email: OutgoingEmail): Promise<void>
}

const RESEND_URL = "https://api.resend.com/emails"
const ATTEMPTS = 3

/**
 * Resend's REST API (https://resend.com/docs/api-reference/emails/send-email), through fetch.
 * A 429 (Resend allows a few requests a second) or a 5xx is tried again after a pause;
 * anything else throws. Logs never carry the address, only the status.
 */
export function createResendSender(options: {
    apiKey: string
    from: string
    logger?: LogService
    fetch?: typeof fetch
    wait?: (ms: number) => Promise<void>
}): EmailSender {
    const { apiKey, from, logger = silentLogger } = options
    const doFetch = options.fetch ?? fetch
    const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

    return {
        async send(email) {
            const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
            // hashed: the key can name a tenant id, and Resend caps its length
            if (email.idempotencyKey) headers["Idempotency-Key"] = createHash("sha256").update(email.idempotencyKey).digest("hex")
            const body = JSON.stringify({ from, to: [email.to], subject: email.subject, html: email.html, text: email.text })

            for (let attempt = 1; ; attempt++) {
                const res = await doFetch(RESEND_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) })
                if (res.ok) return
                const retry = res.status === 429 || res.status >= 500
                if (!retry || attempt >= ATTEMPTS) {
                    const detail = await res.text().catch(() => "")
                    throw new Error(`Resend answered ${res.status}: ${detail.slice(0, 300)}`)
                }
                const after = Number(res.headers.get("retry-after"))
                logger.warn("email.retry", { status: res.status, attempt })
                await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * attempt)
            }
        },
    }
}
