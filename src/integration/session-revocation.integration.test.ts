import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * 012: an access token already issued stops working the moment its account is deactivated,
 * has its sign-in reset, or changes role. Each test keeps a copy of the access cookie from
 * before the change and replays it, as someone holding on to their last 15 minutes would.
 */
const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("access tokens follow the account (012)", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    let admin: Client
    const browser = () => new Client(host, config.webOrigin)

    /** Invite a teammate, sign them up and in. Returns their id, their client, and a copy of their access cookie. */
    async function teammate(name: string, role: "admin" | "maintenance_staff") {
        const email = `${name.toLowerCase()}@example.com`
        const password = `${name} long password 1`
        const invite = await admin.post("/api/manager/team", { name, email, role })
        expect(invite.status).toBe(201)
        const signup = await browser().post("/api/auth/signup", { token: new URL(invite.body.inviteLink).searchParams.get("token"), password })
        expect(signup.status).toBe(201)
        const client = await browser().signIn({ email, password })
        return { id: invite.body.id as number, email, client, stolen: `access_token=${client.cookie("access_token")}` }
    }
    const replay = (cookie: string, method: string, path: string, body?: unknown) => browser().call(method, path, { cookie, body })
    const staffCount = async () => (await t.owner.query("SELECT count(*)::int AS n FROM Admin")).rows[0].n as number

    beforeAll(async () => {
        t = await freshDatabase("it_session_revocation")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        ;({ host, close } = await listen(createApp(container)))
        admin = await browser().signIn(ACCOUNTS.admin)
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    it("a deactivated property manager cannot use their old access token to invite a new one", async () => {
        const mallory = await teammate("Mallory", "admin")
        expect((await replay(mallory.stolen, "GET", "/api/manager/team")).status).toBe(200)   // works while active
        expect((await admin.delete(`/api/manager/team/${mallory.id}`)).status).toBe(200)

        const before = await staffCount()
        const invite = await replay(mallory.stolen, "POST", "/api/manager/team", { name: "Back Door", email: "back.door@example.com", role: "admin" })
        expect(invite.status).toBe(401)
        expect(invite.body).toEqual({ error: "INVALID_TOKEN" })
        expect(await staffCount()).toBe(before)
        expect((await replay(mallory.stolen, "GET", "/api/auth/me")).status).toBe(401)
        expect((await mallory.client.post("/api/auth/refresh")).status).toBe(401)
    })

    it("a sign-in reset ends the old access token, and it stays dead after they sign up again", async () => {
        const riley = await teammate("Riley", "admin")
        const reset = await admin.post(`/api/manager/team/${riley.id}/reset`)
        expect(reset.status).toBe(200)
        expect((await replay(riley.stolen, "GET", "/api/manager/team")).status).toBe(401)

        const again = await browser().post("/api/auth/signup", { token: new URL(reset.body.inviteLink).searchParams.get("token"), password: "Riley second password 2" })
        expect(again.status).toBe(201)
        expect((await replay(riley.stolen, "GET", "/api/manager/team")).status).toBe(401)   // active again, but the token is from before
        const fresh = await browser().signIn({ email: riley.email, password: "Riley second password 2" })
        expect((await fresh.get("/api/manager/team")).status).toBe(200)
    })

    it("a demotion applies at once: the old token is refused, and a refresh brings the lesser role", async () => {
        const devon = await teammate("Devon", "admin")
        expect((await admin.put(`/api/manager/team/${devon.id}`, { role: "maintenance_staff" })).status).toBe(200)

        expect((await replay(devon.stolen, "POST", "/api/manager/team", { name: "Friend", email: "friend@example.com", role: "admin" })).status).toBe(401)
        expect((await devon.client.post("/api/auth/refresh")).status).toBe(200)   // still a teammate: the session goes on
        expect((await devon.client.get("/api/auth/me")).body.user.role).toBe("maintenance_staff")
        expect((await devon.client.get("/api/manager/team")).status).toBe(403)
        expect((await devon.client.get("/api/manager/maintenance")).status).toBe(200)
    })

    it("renaming a teammate does not sign them out", async () => {
        const noor = await teammate("Noor", "maintenance_staff")
        expect((await admin.put(`/api/manager/team/${noor.id}`, { name: "Noor A." })).status).toBe(200)
        expect((await replay(noor.stolen, "GET", "/api/manager/maintenance")).status).toBe(200)
    })

    it("covers tenants too: a deactivated tenant's access token stops working", async () => {
        const tenant = await browser().signIn(ACCOUNTS.tenant)
        const stolen = `access_token=${tenant.cookie("access_token")}`
        expect((await replay(stolen, "GET", "/api/tenant/summary")).status).toBe(200)
        // Straight in the database (the office cannot deactivate a tenant who is on a lease): the check must not depend on which code made the change.
        await t.owner.query("UPDATE Tenants SET deactivated_at = now() WHERE Email = $1", [ACCOUNTS.tenant.email])
        expect((await replay(stolen, "GET", "/api/tenant/summary")).status).toBe(401)
    })

    it("nothing but the trigger moves a token version: it cannot be wound back by hand", async () => {
        const { rows } = await t.owner.query("SELECT admin_id, token_version FROM Admin WHERE deactivated_at IS NOT NULL LIMIT 1")
        expect(rows[0].token_version).toBeGreaterThan(0)
        await t.owner.query("UPDATE Admin SET token_version = 0 WHERE admin_id = $1", [rows[0].admin_id])
        expect((await t.owner.query("SELECT token_version FROM Admin WHERE admin_id = $1", [rows[0].admin_id])).rows[0].token_version).toBe(rows[0].token_version)
    })
})
