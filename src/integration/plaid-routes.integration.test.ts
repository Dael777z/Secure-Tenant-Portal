import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import type { PlaidGateway } from "../services/plaid"
import { AppError } from "../types/errors"
import { decryptSecret } from "../utils/secrets"
import { ACCOUNTS, Client, createTenant, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/**
 * Bank linking over HTTP with a stand-in for Plaid (the real one is covered by plaid-gateway.test.ts).
 * Scope is linking only: no money moves through Plaid yet, so transfers are not tested here.
 */
const config = loadConfig({ NODE_ENV: "test" })
const TOKEN = "access-sandbox-TOPSECRET"
const NUMBER = "1111222233334444"

describe.skipIf(!hasDatabase)("Plaid bank linking (stand-in Plaid)", () => {
    let t: TestDatabase
    let container: Container
    let host: string
    let close: () => Promise<void>
    const seen = { link: [] as string[], exchange: [] as string[] }
    let failWith: AppError | null = null

    const fakePlaid: PlaidGateway = {
        async createLinkToken(clientUserId) { seen.link.push(clientUserId); return "link-sandbox-abc" },
        async exchangeAndGetAuth(publicToken) {
            seen.exchange.push(publicToken)
            if (failWith) throw failWith
            return {
                itemId: "item-1",
                accessToken: TOKEN,
                accounts: [{ accountId: "acc-1", name: "Plaid Checking", mask: "4444", subtype: "checking", accountNumber: NUMBER, routingNumber: "011401533" }],
            }
        },
    }
    const tenant = () => new Client(host, config.webOrigin).signIn(ACCOUNTS.tenant)
    const admin = () => new Client(host, config.webOrigin).signIn(ACCOUNTS.admin)
    const bankRows = async () => (await t.owner.query("SELECT count(*)::int AS n FROM Bank_Accounts WHERE plaid_account_id = 'acc-1'")).rows[0].n as number

    beforeAll(async () => {
        t = await freshDatabase("it_plaid_routes")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: fakePlaid })
        ;({ host, close } = await listen(createApp(container)))
    })
    afterAll(async () => {
        await close?.()
        await container?.close()
        await t?.drop()
    })

    it("gives a signed-in tenant a link token made for their own account", async () => {
        const res = await (await tenant()).post("/api/create_link_token")
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ link_token: "link-sandbox-abc" })
        expect(seen.link.at(-1)).toMatch(/^tenant:\d+$/)
    })

    it("refuses a bad public token before asking Plaid anything", async () => {
        const client = await tenant()
        const before = seen.exchange.length
        for (const bad of [undefined, 42, "", "x".repeat(301)]) {
            const res = await client.post("/api/exchange_and_get_auth", { public_token: bad })
            expect(res.status, String(bad)).toBe(400)
        }
        expect(seen.exchange.length).toBe(before)
    })

    it("saves the account, keeps the access token encrypted, and shows the browser only masked numbers", async () => {
        const client = await tenant()
        const res = await client.post("/api/exchange_and_get_auth", { public_token: "public-sandbox-1" })
        expect(res.status).toBe(200)
        expect(res.body.accounts).toEqual([{ name: "Plaid Checking", mask: "4444", subtype: "checking", account_number: "••••4444", routing_number: "011401533" }])
        expect(res.body.bankAccounts).toHaveLength(1)
        const wire = res.bytes.toString("utf8")
        expect(wire).not.toContain(TOKEN)
        expect(wire).not.toContain(NUMBER)

        const stored = (await t.owner.query("SELECT access_token_enc FROM Bank_Accounts WHERE plaid_account_id = 'acc-1'")).rows[0].access_token_enc as string
        expect(stored).not.toContain(TOKEN)
        expect(stored.startsWith("v1.")).toBe(true)
        expect(decryptSecret(stored, config.tokenEncryptionKey)).toBe(TOKEN)
    })

    it("linking the same account again updates it instead of adding a copy", async () => {
        const client = await tenant()
        await client.post("/api/exchange_and_get_auth", { public_token: "public-sandbox-2" })
        expect(await bankRows()).toBe(1)
    })

    it("lists only id, name, mask and type on the summary, and only for its owner", async () => {
        const mine = (await (await tenant()).get("/api/tenant/summary")).body.bankAccounts
        expect(mine).toHaveLength(1)
        expect(Object.keys(mine[0]).sort()).toEqual(["id", "mask", "name", "subtype"])

        const other = await createTenant(await admin(), host, config.webOrigin)
        expect((await other.get("/api/tenant/summary")).body.bankAccounts).toEqual([])
    })

    it("a tenant can pay from their own linked account but not from someone else's", async () => {
        const owner = await tenant()
        const accountId = Number((await owner.get("/api/tenant/summary")).body.bankAccounts[0].id)
        const amount = (await owner.get("/api/tenant/summary")).body.payLimits.minimum
        expect((await owner.post("/api/tenant/payments", { amount, bankAccountId: accountId })).status).toBe(201)

        const other = await createTenant(await admin(), host, config.webOrigin)
        const stolen = await other.post("/api/tenant/payments", { amount: 25, bankAccountId: accountId })
        expect(stolen.status).toBe(404)
        expect(stolen.body.error).toBe("NOT_FOUND")
    })

    it("passes a Plaid failure on as 502 with Plaid's code, and saves nothing", async () => {
        const before = await bankRows()
        failWith = new AppError("PLAID_ERROR", { operation: "auth_get", plaidCode: "ITEM_LOGIN_REQUIRED", requestId: "req-1" })
        try {
            const res = await (await tenant()).post("/api/exchange_and_get_auth", { public_token: "public-sandbox-3" })
            expect(res.status).toBe(502)
            expect(res.body).toEqual({ error: "PLAID_ERROR", details: { operation: "auth_get", plaidCode: "ITEM_LOGIN_REQUIRED", requestId: "req-1" } })
        } finally {
            failWith = null
        }
        expect(await bankRows()).toBe(before)
    })
})
