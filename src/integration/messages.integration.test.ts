// Messages between a tenant and the property office (004): the conversation
// over HTTP, the read receipts, archive, and the database's own limits
// (probed as summit_app, like the M2 acceptance tests). Skipped without TEST_DATABASE_URL.
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("messages: tenant ↔ property office", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let base: string
    let a: number            // tenant@example.com
    let b: number            // james.johnson@example.com
    let manager: number      // manager@example.com
    let staff: number        // maintenance@example.com

    beforeAll(async () => {
        t = await freshDatabase("it_messages")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        const tenant = async (email: string) => (await t.owner.query("SELECT tID AS id FROM Tenants WHERE Email = $1", [email])).rows[0].id as number
        const admin = async (email: string) => (await t.owner.query("SELECT admin_id AS id FROM Admin WHERE email = $1", [email])).rows[0].id as number
        a = await tenant("tenant@example.com")
        b = await tenant("james.johnson@example.com")
        manager = await admin("manager@example.com")
        staff = await admin("maintenance@example.com")
        container = createContainer({ config, db: t.db, plaid: null })
        server = createApp(container).listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    })
    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        await container?.close()
        await t?.drop()
    })

    /** A tiny browser that keeps cookies, signed in as `email`. */
    async function signIn(email: string, password: string) {
        const cookies = new Map<string, string>()
        const call = async (method: string, path: string, body?: unknown) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: {
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                    ...(method === "GET" ? {} : { origin: config.webOrigin }),
                    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            for (const line of res.headers.getSetCookie()) {
                const [name, value] = line.split(";")[0]!.split("=")
                if (value) cookies.set(name!, value)
            }
            const text = await res.text()
            return { status: res.status, body: text ? JSON.parse(text) : {} }
        }
        const c = { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b), put: (p: string, b: unknown) => call("PUT", p, b) }
        expect((await c.post("/auth/login", { email, password })).status).toBe(200)
        return c
    }

    /** Raw SQL as summit_app, as `who`; rolled back. */
    async function probe(who: [string, string, string], sql: string, params: unknown[] = []) {
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', $1, true), set_config('app.user_id', $2, true), set_config('app.user_role', $3, true)", who)
            return (await client.query(sql, params)).rows
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    }

    it("a tenant writes, the office sees it unread, replies, and both sides get receipts", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const office = await signIn("manager@example.com", PASSWORDS.staff)

        const sent = await tenant.post("/tenant/messages", { body: "  The kitchen sink is leaking.  " })
        expect(sent.status).toBe(201)
        expect(sent.body).toMatchObject({ from: "tenant", body: "The kitchen sink is leaking.", readAt: null, senderName: null })

        expect((await office.get("/manager/messages/unread")).body).toEqual({ unread: 1 })
        const inbox = (await office.get("/manager/messages")).body.threads
        expect(inbox).toHaveLength(1)
        expect(inbox[0]).toMatchObject({ tenantId: a, tenantName: "Test Tenant", unread: 1, archived: false, lastMessage: { from: "tenant" } })
        expect(inbox[0].unitLabel).toContain("101")

        // Opening it is the receipt.
        const opened = await office.get(`/manager/messages/${a}`)
        expect(opened.body.tenant).toMatchObject({ id: a, name: "Test Tenant" })
        expect((await office.post(`/manager/messages/${a}/read`)).body).toEqual({ marked: 1 })
        expect((await office.get("/manager/messages/unread")).body).toEqual({ unread: 0 })
        const mine = (await tenant.get("/tenant/messages")).body
        expect(mine.messages[0].readAt).not.toBeNull()

        const reply = await office.post(`/manager/messages/${a}`, { body: "Thanks, a plumber will come by tomorrow." })
        expect(reply.status).toBe(201)
        expect(reply.body).toMatchObject({ from: "office", senderName: "Dana Whitfield", readAt: null })

        const before = (await tenant.get("/tenant/messages")).body
        expect(before.unread).toBe(1)
        expect((await tenant.post("/tenant/messages/read")).body).toEqual({ marked: 1 })
        const after = (await office.get(`/manager/messages/${a}`)).body
        expect(after.messages.map((m: { from: string }) => m.from)).toEqual(["tenant", "office"])
        expect(after.messages[1].readAt).not.toBeNull()
    })

    it("archive moves a conversation out of the inbox until the tenant writes again", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        expect((await office.put(`/manager/messages/${a}/archive`, { archived: true })).status).toBe(200)
        expect((await office.get("/manager/messages")).body.threads).toEqual([])
        expect((await office.get("/manager/messages?box=archived")).body.threads.map((x: { tenantId: number }) => x.tenantId)).toEqual([a])

        // The office writing does not unarchive; the tenant writing does.
        await office.post(`/manager/messages/${a}`, { body: "Following up." })
        expect((await office.get("/manager/messages")).body.threads).toEqual([])
        await tenant.post("/tenant/messages", { body: "One more thing." })
        expect((await office.get("/manager/messages")).body.threads.map((x: { tenantId: number }) => x.tenantId)).toEqual([a])
    })

    it("a manager can start a conversation; archiving one that does not exist is NOT_FOUND", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        expect((await office.put(`/manager/messages/${b}/archive`, { archived: true })).status).toBe(404)
        const empty = (await office.get(`/manager/messages/${b}`)).body
        expect(empty).toMatchObject({ archived: false, messages: [] })
        expect((await office.post(`/manager/messages/${b}`, { body: "Hello James, your lease renewal is ready." })).status).toBe(201)
        const james = await signIn("james.johnson@example.com", PASSWORDS.tenant)
        const his = (await james.get("/tenant/messages")).body
        expect(his.messages).toHaveLength(1)
        expect(his.messages[0].body).toContain("James")
        expect(JSON.stringify(his)).not.toContain("sink")   // nothing of tenant A's
    })

    it("refuses empty and over-long messages, and keeps maintenance staff and tenants out of the office routes", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const maint = await signIn("maintenance@example.com", PASSWORDS.staff)
        expect((await tenant.post("/tenant/messages", { body: "   " })).status).toBe(400)
        expect((await tenant.post("/tenant/messages", { body: "x".repeat(2001) })).status).toBe(400)
        expect((await tenant.get("/manager/messages")).status).toBe(403)
        expect((await tenant.get(`/manager/messages/${a}`)).status).toBe(403)
        expect((await maint.get("/manager/messages")).status).toBe(403)
        expect((await maint.get("/tenant/messages")).status).toBe(403)
    })

    describe("database-level probes (summit_app)", () => {
        it("a tenant reads only their own conversation and cannot write into another", async () => {
            const rows = await probe(["tenant", String(b), ""], "SELECT DISTINCT tID AS tid FROM Messages")
            expect(rows.map((r) => r.tid)).toEqual([b])
            await expect(probe(["tenant", String(b), ""], "INSERT INTO Messages (tID, body) VALUES ($1, 'probe')", [a])).rejects.toMatchObject({ code: "42501" })
            // …nor pose as the office.
            await expect(probe(["tenant", String(b), ""], "INSERT INTO Messages (tID, sender_admin_id, body) VALUES ($1, $2, 'probe')", [b, manager])).rejects.toMatchObject({ code: "42501" })
        })

        it("a manager writes only as themselves; maintenance staff see nothing", async () => {
            const other = manager === 1 ? 2 : 1
            await expect(probe(["admin", String(manager), "admin"], "INSERT INTO Messages (tID, sender_admin_id, body) VALUES ($1, $2, 'probe')", [a, other])).rejects.toMatchObject({ code: "42501" })
            expect(await probe(["admin", String(staff), "maintenance_staff"], "SELECT 1 FROM Messages")).toEqual([])
            expect(await probe(["admin", String(staff), "maintenance_staff"], "SELECT 1 FROM Message_Threads")).toEqual([])
        })

        it("messages cannot be edited or deleted, and a receipt cannot be undone", async () => {
            const admin: [string, string, string] = ["admin", String(manager), "admin"]
            await expect(probe(admin, "UPDATE Messages SET body = 'changed'")).rejects.toMatchObject({ code: "42501" })
            await expect(probe(admin, "DELETE FROM Messages")).rejects.toMatchObject({ code: "42501" })
            await expect(probe(admin, "UPDATE Messages SET read_at = NULL WHERE sender_admin_id IS NULL AND read_at IS NOT NULL")).rejects.toMatchObject({ code: "42501" })
        })

        it("a tenant cannot mark their own message read for the office", async () => {
            const own = await probe(["tenant", String(a), ""], "UPDATE Messages SET read_at = now() WHERE sender_admin_id IS NULL AND read_at IS NULL RETURNING 1")
            expect(own).toEqual([])
        })
    })
})
