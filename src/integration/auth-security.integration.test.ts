import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * Sessions and sign-in as an attacker would poke at them: cookie flags, refresh-token reuse, logout,
 * account enumeration, bad sign-up input, and the real (non-test) rate limits.
 */
const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("sessions, sign-in and rate limits", () => {
    let t: TestDatabase
    const containers: Container[] = []
    const closers: Array<() => Promise<void>> = []
    let normal: string      // the app as the other tests use it
    let secure: string      // cookies marked Secure, as in production
    let limited: string     // small rate limits

    async function start(overrides: Partial<typeof config>) {
        const container = createContainer({ config: { ...config, ...overrides }, db: t.db, plaid: null })
        containers.push(container)
        const { host, close } = await listen(createApp(container))
        closers.push(close)
        return host
    }
    const browser = (host: string) => new Client(host, config.webOrigin)

    beforeAll(async () => {
        t = await freshDatabase("it_auth_security")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        normal = await start({})
        secure = await start({ secureCookies: true })
        limited = await start({ rateLimits: { login: 3, signup: 2, refresh: 2, sensitive: 50, messages: 50 } })
    })
    afterAll(async () => {
        await Promise.all(closers.map((close) => close()))
        await Promise.all(containers.map((c) => c.close()))
        await t?.drop()
    })

    describe("cookies", () => {
        const flags = async (host: string) => {
            const res = await browser(host).post("/api/auth/login", ACCOUNTS.admin)
            const byName = (name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!
            return { access: byName("access_token"), refresh: byName("refresh_token") }
        }
        it("both are HttpOnly for the whole site; the access cookie is Lax and the refresh cookie Strict", async () => {
            const { access, refresh } = await flags(normal)
            for (const cookie of [access, refresh]) {
                expect(cookie).toMatch(/HttpOnly/i)
                expect(cookie).toMatch(/Path=\//i)
            }
            expect(access).toMatch(/SameSite=Lax/i)
            expect(refresh).toMatch(/SameSite=Strict/i)
            expect(access).not.toMatch(/;\s*Secure/i)   // plain http on a developer machine
        })
        it("both are Secure when the site runs over https", async () => {
            const { access, refresh } = await flags(secure)
            expect(access).toMatch(/;\s*Secure/i)
            expect(refresh).toMatch(/;\s*Secure/i)
        })
    })

    describe("refresh tokens", () => {
        it("each works once: the old one is refused after a refresh", async () => {
            const client = await browser(normal).signIn(ACCOUNTS.tenant)
            const old = client.cookie("refresh_token")!
            expect((await client.post("/api/auth/refresh")).status).toBe(200)
            expect(client.cookie("refresh_token")).not.toBe(old)

            const replay = await browser(normal).call("POST", "/api/auth/refresh", { cookie: `refresh_token=${old}`, body: {} })
            expect(replay.status).toBe(401)
            expect(replay.body.error).toBe("INVALID_TOKEN")
        })

        // Documents current behaviour: replaying a used token is refused but does not end the session it
        // came from (no "token family" revocation). Stricter systems sign the user out everywhere here.
        it("a replayed old token does not cancel the newest one", async () => {
            const client = await browser(normal).signIn(ACCOUNTS.tenant)
            const old = client.cookie("refresh_token")!
            await client.post("/api/auth/refresh")
            await browser(normal).call("POST", "/api/auth/refresh", { cookie: `refresh_token=${old}`, body: {} })
            expect((await client.post("/api/auth/refresh")).status).toBe(200)
        })

        it("with no cookie, or a made-up one, there is no session", async () => {
            expect((await browser(normal).post("/api/auth/refresh")).status).toBe(401)
            const fake = await browser(normal).call("POST", "/api/auth/refresh", { cookie: "refresh_token=nope", body: {} })
            expect(fake.status).toBe(401)
        })
    })

    describe("logout", () => {
        it("kills the refresh token; logging out twice, or with no session, is harmless", async () => {
            const client = await browser(normal).signIn(ACCOUNTS.admin)
            const refresh = client.cookie("refresh_token")!
            expect((await client.post("/api/auth/logout")).status).toBe(204)
            expect((await browser(normal).call("POST", "/api/auth/refresh", { cookie: `refresh_token=${refresh}`, body: {} })).status).toBe(401)
            expect((await client.post("/api/auth/logout")).status).toBe(204)
            expect((await browser(normal).post("/api/auth/logout")).status).toBe(204)
        })

        // Documents current behaviour: the 15-minute access token is a stateless JWT, so a copy taken
        // before logout keeps working until it expires. That is the usual trade-off for short-lived tokens.
        it("an access token copied before logout still works until it expires", async () => {
            const client = await browser(normal).signIn(ACCOUNTS.admin)
            const access = client.cookie("access_token")!
            await client.post("/api/auth/logout")
            const res = await browser(normal).call("GET", "/api/auth/me", { cookie: `access_token=${access}` })
            expect(res.status).toBe(200)
        })
    })

    describe("sign-in", () => {
        it("answers the same for an unknown email and a wrong password (no account enumeration)", async () => {
            const wrong = await browser(normal).post("/api/auth/login", { email: ACCOUNTS.admin.email, password: "not-the-password" })
            const unknown = await browser(normal).post("/api/auth/login", { email: "nobody@example.com", password: "not-the-password" })
            expect(wrong.status).toBe(401)
            expect(unknown.status).toBe(wrong.status)
            expect(unknown.body).toEqual(wrong.body)
            expect(wrong.body).toEqual({ error: "INVALID_CREDENTIALS" })
        })
        it("ignores case and surrounding spaces in the email", async () => {
            const res = await browser(normal).post("/api/auth/login", { email: `  ${ACCOUNTS.admin.email.toUpperCase()} `, password: ACCOUNTS.admin.password })
            expect(res.status).toBe(200)
        })
        it("refuses a body that is not two strings", async () => {
            for (const body of [{}, { email: 5, password: "x" }, { email: ACCOUNTS.admin.email }, { email: ["a"], password: ["b"] }]) {
                expect((await browser(normal).post("/api/auth/login", body)).status, JSON.stringify(body)).toBe(400)
            }
        })
        it("never puts the password hash or any token in the sign-in response body", async () => {
            const res = await browser(normal).post("/api/auth/login", ACCOUNTS.admin)
            expect(Object.keys(res.body.user).sort()).toEqual(["email", "permissions", "role", "user_id"])
            expect(res.bytes.toString("utf8")).not.toMatch(/\$2[aby]\$|token/i)
        })
    })

    describe("sign-up with an invitation", () => {
        async function invite() {
            const admin = await browser(normal).signIn(ACCOUNTS.admin)
            const tag = Math.random().toString(36).slice(2, 8)
            const property = await admin.post("/api/manager/properties", { name: `Sec ${tag}`, address: "1 Test St" })
            const unit = await admin.post("/api/manager/units", { propertyId: property.body.id, unitNum: "S1" })
            const lease = await admin.post("/api/manager/leases", {
                unitId: unit.body.id, startDate: "2026-09-01", monthlyRent: 700, newTenants: [{ name: "Sign Up", email: `signup.${tag}@example.com` }],
            })
            expect(lease.status).toBe(201)
            return lease.body.invites[0].inviteToken as string
        }
        it("refuses bad input without using up the invitation", async () => {
            const token = await invite()
            const client = browser(normal)
            expect((await client.post("/api/auth/signup", { token, password: "short" })).status).toBe(400)
            expect((await client.post("/api/auth/signup", { token: "t".repeat(301), password: "long-enough-pw" })).status).toBe(400)
            expect((await client.post("/api/auth/signup", { token: 123, password: "long-enough-pw" })).status).toBe(400)
            expect((await client.post("/api/auth/signup", { token, password: "long-enough-pw" })).status).toBe(201)
        })
        it("an unknown or used token gets the same refusal", async () => {
            const token = await invite()
            await browser(normal).post("/api/auth/signup", { token, password: "long-enough-pw" })
            const used = await browser(normal).post("/api/auth/signup", { token, password: "another-long-pw" })
            const unknown = await browser(normal).post("/api/auth/signup", { token: "made-up-token", password: "another-long-pw" })
            expect(used.status).toBe(403)
            expect(unknown.status).toBe(used.status)
            expect(unknown.body).toEqual(used.body)
        })
    })

    describe("rate limits (the app run with small limits)", () => {
        it("stops sign-in guessing after 3 tries, even with the right password", async () => {
            const client = browser(limited)
            for (let i = 0; i < 3; i++) expect((await client.post("/api/auth/login", { email: ACCOUNTS.admin.email, password: `guess-${i}` })).status).toBe(401)
            const blocked = await client.post("/api/auth/login", ACCOUNTS.admin)
            expect(blocked.status).toBe(429)
            expect(blocked.body).toEqual({ error: "RATE_LIMITED" })
        })
        it("stops sign-up guessing and refresh guessing on their own allowances", async () => {
            const client = browser(limited)
            for (let i = 0; i < 2; i++) expect((await client.post("/api/auth/signup", { token: `bad-token-${i}`, password: "long-enough-pw" })).status).toBe(403)
            expect((await client.post("/api/auth/signup", { token: "bad-token-3", password: "long-enough-pw" })).status).toBe(429)
            for (let i = 0; i < 2; i++) expect((await client.post("/api/auth/refresh")).status).toBe(401)
            expect((await client.post("/api/auth/refresh")).status).toBe(429)
        })
    })
})
