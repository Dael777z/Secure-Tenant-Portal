import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { totpCode, totpStep } from "../utils/totp"
import { ACCOUNTS, Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * 013: staff two-step sign-in and the 30-day staff session, through the real routes and
 * database functions. Run as production does: no staff sign-in without a code.
 */
const config = { ...loadConfig({ NODE_ENV: "test" }), requireStaffMfa: true }

describe.skipIf(!hasDatabase)("staff two-step sign-in (013)", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    const browser = () => new Client(host, config.webOrigin)
    const admin = (email: string) => t.owner.query("SELECT mfa_enabled, mfa_secret_encrypted FROM Admin WHERE email = $1", [email]).then((r) => r.rows[0])

    beforeAll(async () => {
        t = await freshDatabase("it_staff_mfa")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        ;({ host, close } = await listen(createApp(container)))
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    it("a manager cannot sign in without it, sets it up, and then needs a new code every time", async () => {
        const who = ACCOUNTS.admin
        const b = browser()
        expect(await b.post("/api/auth/login", who)).toMatchObject({ status: 401, body: { error: "MFA_SETUP_REQUIRED" } })
        expect(b.cookie("access_token")).toBeUndefined()
        expect(await b.post("/api/auth/mfa/setup", { ...who, password: "not the password" })).toMatchObject({ status: 401, body: { error: "INVALID_CREDENTIALS" } })

        const setup = await b.post("/api/auth/mfa/setup", who)
        expect(setup.status).toBe(200)
        const secret = setup.body.secret as string
        expect(setup.body.uri).toContain(`secret=${secret}`)
        // Stored encrypted, and not on yet.
        const stored = await admin(who.email)
        expect(stored.mfa_enabled).toBe(false)
        expect(stored.mfa_secret_encrypted).toMatch(/^v1\./)
        expect(stored.mfa_secret_encrypted).not.toContain(secret)
        expect(await b.post("/api/auth/login", who)).toMatchObject({ status: 401, body: { error: "MFA_SETUP_REQUIRED" } })

        const code = totpCode(secret, totpStep())
        expect((await b.post("/api/auth/login", { ...who, code })).status).toBe(200)
        expect((await b.get("/api/manager/team")).status).toBe(200)
        expect((await admin(who.email)).mfa_enabled).toBe(true)

        const again = browser()
        expect(await again.post("/api/auth/login", who)).toMatchObject({ status: 401, body: { error: "MFA_REQUIRED" } })
        expect(await again.post("/api/auth/login", { ...who, code })).toMatchObject({ status: 401, body: { error: "MFA_CODE_INVALID" } })   // each code once
        expect(await again.post("/api/auth/login", { ...who, code: 123456 })).toMatchObject({ status: 400 })
        expect((await again.post("/api/auth/login", { ...who, code: totpCode(secret, totpStep() + 1) })).status).toBe(200)
        // On: the password alone no longer gets a new secret.
        expect(await again.post("/api/auth/mfa/setup", who)).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } })

        const events = await t.owner.query("SELECT action FROM Security_Events WHERE action LIKE 'mfa%'")
        expect(events.rows.map((r) => r.action).sort()).toEqual(["mfa_failed", "mfa_setup"])
    })

    it("tenants sign in as before, and cannot start setup", async () => {
        const b = browser()
        expect((await b.post("/api/auth/login", ACCOUNTS.tenant)).status).toBe(200)
        expect(await browser().post("/api/auth/mfa/setup", ACCOUNTS.tenant)).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } })
    })

    it("a staff session ends 30 days after its sign-in, however recently it was refreshed", async () => {
        const who = ACCOUNTS.maintenance
        const b = browser()
        const { secret } = (await b.post("/api/auth/mfa/setup", who)).body
        expect((await b.post("/api/auth/login", { ...who, code: totpCode(secret, totpStep()) })).status).toBe(200)
        const age = (days: number) => t.owner.query(
            "UPDATE Refresh_Tokens SET session_started_at = now() - make_interval(days => $1) WHERE NOT revoked AND admin_id = (SELECT admin_id FROM Admin WHERE email = $2)", [days, who.email])

        await age(29)
        expect((await b.post("/api/auth/refresh")).status).toBe(200)
        // The new token carries the old start: nothing has to be aged again for the session to run out.
        const { rows } = await t.owner.query("SELECT session_started_at < now() - interval '28 days' AS old FROM Refresh_Tokens WHERE NOT revoked AND admin_id = (SELECT admin_id FROM Admin WHERE email = $1)", [who.email])
        expect(rows).toEqual([{ old: true }])

        await age(31)
        expect(await b.post("/api/auth/refresh")).toMatchObject({ status: 401, body: { error: "INVALID_TOKEN" } })
    })
})
