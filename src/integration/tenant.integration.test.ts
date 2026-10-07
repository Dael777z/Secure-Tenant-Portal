// Juan's tenant pages' API and Dael's Plaid routes, on Postgres, over HTTP.
// Plaid itself is replaced by a stand-in so the tests run without the internet.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Server } from "http"
import type { AddressInfo } from "net"
import type { Pool } from "pg"
import pino from "pino"
import bcrypt from "bcrypt"
import { createApp } from "../create-app"
import { LogService } from "../logging/log-service"
import { PostgresDatabase } from "../services/postgres-db"
import { TenantStore } from "../services/tenant-store"
import type { PlaidGateway } from "../services/plaid"
import { decryptSecret } from "../utils/secrets"
import { env } from "../config/env"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_tenant"

const fakePlaid: PlaidGateway & { lastUser?: string } = {
    async createLinkToken(clientUserId) {
        fakePlaid.lastUser = clientUserId
        return "link-sandbox-test"
    },
    async exchangeAndGetAuth(publicToken) {
        if (publicToken !== "public-sandbox-ok") throw new Error("bad token")
        return {
            itemId: "item-1",
            accessToken: "access-sandbox-secret",
            accounts: [
                { accountId: "acc-chk", name: "Plaid Checking", mask: "0000", subtype: "checking", accountNumber: "1111222233330000", routingNumber: "011401533" },
                { accountId: "acc-sav", name: "Plaid Saving", mask: "1111", subtype: "savings", accountNumber: "1111222233331111", routingNumber: "011401533" },
            ],
        }
    },
}

describe.skipIf(!hasDatabase)("tenant API and Plaid routes on Postgres", () => {
    let pool: Pool
    let server: Server
    let base: string
    let dana = ""
    let eli = ""
    let manager = ""

    const post = (path: string, body: unknown, cookie: string) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })
    const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } })
    const signIn = async (email: string, password: string) => {
        const res = await post("/auth/login", { email, password }, "")
        expect(res.status).toBe(200)
        return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
    }

    beforeAll(async () => {
        pool = await freshSchema(SCHEMA)
        const db = new PostgresDatabase(pool)
        const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

        // Dana and Eli share unit 101's lease (cosigners); Fay lives in 102.
        const pid = (await q("INSERT INTO Property (Name, Address) VALUES ('Woodcrest', '2400 Woodcrest Dr') RETURNING pID AS pid")).rows[0].pid
        const u101 = (await q("INSERT INTO Units (pID, UnitNum) VALUES ($1, '101') RETURNING uID AS uid", [pid])).rows[0].uid
        const u102 = (await q("INSERT INTO Units (pID, UnitNum) VALUES ($1, '102') RETURNING uID AS uid", [pid])).rows[0].uid
        const lease101 = (await q("INSERT INTO Lease (uID, start_date, ammount_owed) VALUES ($1, '2026-09-01', 950) RETURNING LeaseID AS id", [u101])).rows[0].id
        const lease102 = (await q("INSERT INTO Lease (uID, start_date, ammount_owed) VALUES ($1, '2026-09-01', 800) RETURNING LeaseID AS id", [u102])).rows[0].id

        const people: Array<[string, string, number]> = [["Dana Diaz", "dana@example.com", lease101], ["Eli Diaz", "eli@example.com", lease101], ["Fay Fox", "fay@example.com", lease102]]
        for (const [name, email, leaseId] of people) {
            const invited = await db.inviteTenant({ name, email })
            await db.completeSignup(email, await bcrypt.hash("long enough", 4))
            await q("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [leaseId, Number(invited.id.split(":")[1])])
        }
        await q("INSERT INTO Maintenance_T (uID, title, status) VALUES ($1, 'Fay''s sink', 'in_progress')", [u102])
        await db.createUser({ email: "manager@example.com", password_h: await bcrypt.hash("manager password", 4), role: "property_manager", name: "Morgan" })

        const store = new TenantStore(pool, { timeZone: "America/Denver", now: () => new Date("2026-10-07T18:00:00Z") })
        const app = createApp({ database: db, logger: new LogService(pino({ level: "silent" })), distRoot: __dirname, tenantStore: store, plaid: fakePlaid })
        server = app.listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

        dana = await signIn("dana@example.com", "long enough")
        eli = await signIn("eli@example.com", "long enough")
        manager = await signIn("manager@example.com", "manager password")
    })

    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        if (pool) await dropSchema(pool, SCHEMA)
    })

    it("the summary has Juan's shapes, from the database", async () => {
        const res = await get("/tenant/summary", dana)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.tenant).toEqual({ id: expect.stringMatching(/^tenant:/), name: "Dana Diaz", initials: "DD", unitLabel: "Unit 101 - Woodcrest", address: "2400 Woodcrest Dr" })
        expect(body.currentBalance).toBe(1900)
        expect(body.rentDueDate).toBe("October 1")
        expect(body.ledger.map((e: { description: string }) => e.description)).toEqual(["Rent charge - October", "Rent charge - September"])
        expect(body.plaidEnabled).toBe(true)
        expect(body.notices[0]).toMatchObject({ type: "due", title: "Rent due October 1" })
    })

    it("a payment by one cosigner shows for both, with method and confirmation", async () => {
        const paid = await post("/tenant/payments", { amount: 950 }, dana)
        expect(paid.status).toBe(201)
        const { confirmation } = await paid.json()
        expect(confirmation).toMatch(/^CONF-\d{8}$/)

        const seenByEli = await (await get("/tenant/summary", eli)).json()
        expect(seenByEli.currentBalance).toBe(950)
        expect(seenByEli.ledger[0]).toMatchObject({ description: "Payment received", amount: 950, balanceAfter: 950, method: "Bank transfer (demo)", confirmation })
        const row = await pool.query("SELECT t.Name AS name FROM Payment p JOIN Tenants t ON t.tID = p.tID WHERE p.confirmation = $1", [confirmation])
        expect(row.rows[0].name).toBe("Dana Diaz")
    })

    it("bad payment amounts are refused", async () => {
        for (const amount of [0, -5, "950", 10.001, 1_000_000]) {
            expect((await post("/tenant/payments", { amount }, dana)).status).toBe(400)
        }
    })

    it("a maintenance request goes on the tenant's unit and shows as open", async () => {
        const res = await post("/tenant/maintenance", { title: "Bathroom fan is loud", description: "Rattles when on." }, eli)
        expect(res.status).toBe(201)
        expect(await res.json()).toMatchObject({ title: "Bathroom fan is loud", status: "open" })
        const stored = await pool.query("SELECT status, u.UnitNum AS unit FROM Maintenance_T m JOIN Units u ON u.uID = m.uID WHERE title = 'Bathroom fan is loud'")
        expect(stored.rows[0]).toEqual({ status: "submitted", unit: "101" })

        const danaSees = await (await get("/tenant/summary", dana)).json()
        expect(danaSees.maintenanceRequests.map((r: { title: string }) => r.title)).toEqual(["Bathroom fan is loud"])
        expect((await post("/tenant/maintenance", { title: "  " }, eli)).status).toBe(400)
    })

    it("a tenant never sees another unit's lease, payments or requests", async () => {
        const fay = await signIn("fay@example.com", "long enough")
        const body = await (await get("/tenant/summary", fay)).json()
        expect(body.tenant.unitLabel).toBe("Unit 102 - Woodcrest")
        expect(body.currentBalance).toBe(1600)
        expect(body.maintenanceRequests.map((r: { title: string }) => r.title)).toEqual(["Fay's sink"])
        expect(JSON.stringify(body)).not.toContain("Bathroom fan")
    })

    it("staff accounts cannot use the tenant routes", async () => {
        expect((await get("/tenant/summary", manager)).status).toBe(403)
        expect((await get("/tenant/summary", "")).status).toBe(401)
    })

    it("Plaid: the link token is for the signed-in tenant", async () => {
        const res = await post("/create_link_token", {}, dana)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ link_token: "link-sandbox-test" })
        expect(fakePlaid.lastUser).toMatch(/^tenant:\d+$/)
        expect((await post("/create_link_token", {}, "")).status).toBe(401)
    })

    it("Plaid: linking saves the accounts, encrypts the token, and never returns or stores the full account number", async () => {
        const res = await post("/exchange_and_get_auth", { public_token: "public-sandbox-ok" }, dana)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.accounts[0]).toEqual({ name: "Plaid Checking", mask: "0000", subtype: "checking", account_number: "••••0000", routing_number: "011401533" })
        expect(body.bankAccounts).toHaveLength(2)
        expect(JSON.stringify(body)).not.toContain("1111222233330000")

        const stored = await pool.query("SELECT * FROM Bank_Accounts")
        expect(JSON.stringify(stored.rows)).not.toContain("1111222233330000")
        expect(JSON.stringify(stored.rows)).not.toContain("access-sandbox-secret")
        expect(decryptSecret(stored.rows[0].access_token_enc, env.tokenEncryptionKey)).toBe("access-sandbox-secret")

        // Linking again updates rather than duplicating.
        await post("/exchange_and_get_auth", { public_token: "public-sandbox-ok" }, dana)
        expect((await pool.query("SELECT 1 FROM Bank_Accounts")).rowCount).toBe(2)
        expect((await post("/exchange_and_get_auth", { public_token: "public-sandbox-bad" }, dana)).status).toBe(502)
    })

    it("paying from a linked account labels the payment with it; another tenant's account is refused", async () => {
        const summary = await (await get("/tenant/summary", dana)).json()
        const account = summary.bankAccounts[0]
        const res = await post("/tenant/payments", { amount: 100.5, bankAccountId: account.id }, dana)
        expect(res.status).toBe(201)
        const after = await (await get("/tenant/summary", dana)).json()
        expect(after.ledger[0]).toMatchObject({ amount: 100.5, method: "Plaid Checking 0000" })

        expect((await post("/tenant/payments", { amount: 10, bankAccountId: account.id }, eli)).status).toBe(404)
    })
})
