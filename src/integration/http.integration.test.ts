// The auth API over real HTTP, on Postgres: what Scott's Insomnia demo does by
// hand (signup, login, /auth/me, refresh, logout), as repeatable tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "http"
import type { AddressInfo } from "net"
import type { Pool } from "pg"
import pino from "pino"
import bcrypt from "bcrypt"
import { createApp } from "../create-app"
import { LogService } from "../logging/log-service"
import { PostgresDatabase } from "../services/postgres-db"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_http"

describe.skipIf(!hasDatabase)("auth API on Postgres", () => {
    let pool: Pool
    let server: Server
    let base: string

    beforeAll(async () => {
        pool = await freshSchema(SCHEMA)
        const database = new PostgresDatabase(pool)
        await database.inviteTenant({ name: "Dana Diaz", email: "dana@example.com", phone: "(575) 555-0101" })
        await database.createUser({
            email: "manager@example.com",
            password_h: await bcrypt.hash("manager password", 4),
            role: "property_manager",
            name: "Morgan",
        })
        const app = createApp({ database, logger: new LogService(pino({ level: "silent" })), distRoot: __dirname })
        server = app.listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    })

    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        if (pool) await dropSchema(pool, SCHEMA)
    })

    const post = (path: string, body?: unknown, cookie = "", headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie, ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        })

    /** The cookies a response sets, as a Cookie header for the next request. */
    const cookiesFrom = (res: Response) =>
        res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ")

    let session = ""

    it("only an invited tenant can sign up, and only once", async () => {
        const stranger = await post("/auth/signup", { email: "stranger@example.com", password: "long enough" })
        expect(stranger.status).toBe(403)
        expect(await stranger.json()).toEqual({ error: "SIGNUP_NOT_ALLOWED" })

        const dana = await post("/auth/signup", { email: " Dana@Example.com ", password: "long enough" })
        expect(dana.status).toBe(201)
        expect(await dana.json()).toEqual({ id: expect.stringMatching(/^tenant:\d+$/), email: "dana@example.com", role: "tenant" })

        const again = await post("/auth/signup", { email: "dana@example.com", password: "another one" })
        expect(again.status).toBe(403)
    })

    it("a short password is refused", async () => {
        expect((await post("/auth/signup", { email: "dana@example.com", password: "short" })).status).toBe(400)
    })

    it("login sets httpOnly cookies, and /auth/me reads them", async () => {
        const res = await post("/auth/login", { email: "dana@example.com", password: "long enough" })
        expect(res.status).toBe(200)
        const setCookies = res.headers.getSetCookie()
        expect(setCookies.find((c) => c.startsWith("access_token="))).toMatch(/HttpOnly/i)
        expect(setCookies.find((c) => c.startsWith("refresh_token="))).toMatch(/HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/i)
        session = cookiesFrom(res)

        const me = await fetch(`${base}/auth/me`, { headers: { cookie: session } })
        expect(me.status).toBe(200)
        expect(await me.json()).toEqual({
            user: {
                user_id: expect.stringMatching(/^tenant:\d+$/),
                role: "tenant",
                permissions: ["ledger:read:self", "payment:create:self", "maintenance:create"],
            },
        })
    })

    it("a wrong password and an unknown email get the same answer", async () => {
        const wrong = await post("/auth/login", { email: "dana@example.com", password: "not the password" })
        const unknown = await post("/auth/login", { email: "nobody@example.com", password: "not the password" })
        expect(wrong.status).toBe(401)
        expect(unknown.status).toBe(401)
        expect(await wrong.json()).toEqual(await unknown.json())
    })

    it("staff sign in from the Admin table with their role's permissions", async () => {
        const res = await post("/auth/login", { email: "manager@example.com", password: "manager password" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.user).toMatchObject({ user_id: expect.stringMatching(/^admin:\d+$/), role: "property_manager" })
        expect(body.user.permissions).toContain("users:provision")
    })

    it("refresh rotates the token, and the old one stops working", async () => {
        const first = await post("/auth/refresh", undefined, session)
        expect(first.status).toBe(200)
        const rotated = cookiesFrom(first)
        expect(rotated).toContain("refresh_token=")

        const replay = await post("/auth/refresh", undefined, session)
        expect(replay.status).toBe(401)

        const rows = await pool.query("SELECT revoked FROM Refresh_Tokens WHERE tID IS NOT NULL ORDER BY created_at")
        expect(rows.rows.map((r) => r.revoked)).toEqual([true, false])
        session = rotated
    })

    it("logout revokes the refresh token", async () => {
        const out = await post("/auth/logout", undefined, session)
        expect(out.status).toBe(204)
        expect((await post("/auth/refresh", undefined, session)).status).toBe(401)
    })

    it("a state-changing request from another site's page is refused", async () => {
        const res = await post("/auth/login", { email: "dana@example.com", password: "long enough" }, "", { origin: "https://evil.example" })
        expect(res.status).toBe(403)
    })

    it("an unknown /api path is a JSON 404, not the page shell", async () => {
        const res = await fetch(`${base}/nope`)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: "NOT_FOUND" })
    })
})
