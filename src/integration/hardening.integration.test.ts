import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { createLogger } from "../logging"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/** The small defences found in the security review, over real HTTP. */
const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("hardening over HTTP", () => {
    let t: TestDatabase
    let container: Container
    let started: Awaited<ReturnType<typeof listen>>
    let admin: Client
    const lines: Array<Record<string, any>> = []

    beforeAll(async () => {
        t = await freshDatabase("it_hardening")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        const logger = createLogger({ logFile: "", serviceName: "portal", mode: "development" }, { write: (chunk: string) => { lines.push(JSON.parse(chunk)) } })
        container = createContainer({ config, db: t.db, plaid: null, logger })
        started = await listen(createApp(container))
        admin = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.admin)
    })
    afterAll(async () => {
        await started?.close()
        await container?.close()
        await t?.drop()
    })

    it("sign-up refuses a common password with PASSWORD_TOO_COMMON, then accepts a good one", async () => {
        const invite = await admin.post("/api/manager/tenants", { name: "Pick Pass", email: "pick.pass@example.com" })
        const anonymous = new Client(started.host, config.webOrigin)
        const weak = await anonymous.post("/api/auth/signup", { token: invite.body.inviteToken, password: "12345678" })
        expect(weak.status).toBe(400)
        expect(weak.body).toEqual({ error: "PASSWORD_TOO_COMMON" })
        const good = await anonymous.post("/api/auth/signup", { token: invite.body.inviteToken, password: "blue.kettle.window" })   // the refused try did not burn the invitation
        expect(good.status).toBe(201)
    })

    it("the refresh cookie is only sent to /api/auth; the access cookie to the whole site", async () => {
        const res = await new Client(started.host, config.webOrigin).call("POST", "/api/auth/login", { body: ACCOUNTS.tenant })
        const cookies = res.headers.getSetCookie()
        expect(cookies.find((c) => c.startsWith("access_token="))).toContain("Path=/;")
        expect(cookies.find((c) => c.startsWith("refresh_token="))).toContain("Path=/api/auth;")
        const client = new Client(started.host, config.webOrigin)
        await client.call("POST", "/api/auth/login", { body: ACCOUNTS.tenant })
        expect((await client.call("POST", "/api/auth/refresh")).status).toBe(200)
        const out = await client.call("POST", "/api/auth/logout")
        expect(out.headers.getSetCookie().find((c) => c.startsWith("refresh_token="))).toContain("Path=/api/auth")   // cleared where it was set
    })

    it("a write the browser marks as cross-site or same-site is refused, even without an Origin header", async () => {
        const cookie = `access_token=${admin.cookie("access_token")}`
        const send = (site: string) => fetch(`${started.host}/api/manager/properties`, { method: "POST", headers: { "content-type": "application/json", cookie, "sec-fetch-site": site }, body: JSON.stringify({ name: `P ${site}`, address: "1 Test" }) }).then((r) => r.status)
        expect(await send("cross-site")).toBe(403)
        expect(await send("same-site")).toBe(403)
        expect(await send("same-origin")).toBe(201)
        const read = await fetch(`${started.host}/api/manager/properties`, { headers: { cookie, "sec-fetch-site": "cross-site" } })
        expect(read.status).toBe(200)   // reads are not touched
    })

    it("every request line records the client address, and the user when there is one", async () => {
        const tenant = await new Client(started.host, config.webOrigin).signIn(ACCOUNTS.tenant)
        await tenant.get("/api/tenant/summary")
        const done = lines.filter((l) => l.event === "request.completed" && l.metadata.path === "/api/tenant/summary")
        expect(done.length).toBeGreaterThan(0)
        expect(done[done.length - 1]!.metadata).toMatchObject({ ip: expect.stringMatching(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/), user: expect.stringMatching(/^tenant:\d+$/) })
        await new Client(started.host, config.webOrigin).get("/api/auth/me")
        const anon = lines.filter((l) => l.event === "request.completed" && l.metadata.path === "/api/auth/me").pop()!
        expect(anon.metadata.ip).toBeTruthy()
        expect(anon.metadata.user).toBeUndefined()
    })
})
