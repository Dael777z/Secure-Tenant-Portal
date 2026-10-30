import { describe, expect, it } from "vitest"

import { createResendSender } from "./email"

type Call = { url: string; init: RequestInit }

function fakeFetch(...statuses: number[]) {
    const calls: Call[] = []
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!
        return new Response(status < 300 ? '{"id":"e_1"}' : '{"message":"nope"}', { status })
    }) as unknown as typeof globalThis.fetch
    return { fetch, calls }
}

const EMAIL = { to: "lee@home.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "past_due:4:55" }

describe("Resend sender", () => {
    it("posts one email to Resend with the key, sender and a hashed idempotency key", async () => {
        const { fetch, calls } = fakeFetch(200)
        await createResendSender({ apiKey: "re_test", from: "Summit <rent@example.com>", fetch }).send(EMAIL)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe("https://api.resend.com/emails")
        const headers = calls[0]!.init.headers as Record<string, string>
        expect(headers.Authorization).toBe("Bearer re_test")
        expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: "Summit <rent@example.com>", to: ["lee@home.test"], subject: "Hi", html: "<p>Hi</p>", text: "Hi" })
    })

    it("waits and tries again on 429 and 5xx", async () => {
        const { fetch, calls } = fakeFetch(429, 503, 200)
        const waits: number[] = []
        await createResendSender({ apiKey: "k", from: "a@b.co", fetch, wait: async (ms) => { waits.push(ms) } }).send(EMAIL)
        expect(calls).toHaveLength(3)
        expect(waits).toEqual([1000, 2000])
    })

    it("throws on a 4xx it cannot fix, and after the last attempt", async () => {
        await expect(createResendSender({ apiKey: "k", from: "a@b.co", fetch: fakeFetch(422).fetch }).send(EMAIL)).rejects.toThrow("Resend answered 422")
        const { fetch, calls } = fakeFetch(500)
        await expect(createResendSender({ apiKey: "k", from: "a@b.co", fetch, wait: async () => undefined }).send(EMAIL)).rejects.toThrow("Resend answered 500")
        expect(calls).toHaveLength(3)
    })
})
