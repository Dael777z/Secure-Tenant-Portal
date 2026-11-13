import { beforeEach, describe, expect, it, vi } from "vitest"

import { createLogger } from "../logging"
import { createPlaidGateway } from "./plaid"

// Plaid's SDK is replaced, so no network and no account is needed. (Bank linking only: no money moves yet.)
const plaid = vi.hoisted(() => ({
    api: { linkTokenCreate: vi.fn(), itemPublicTokenExchange: vi.fn(), authGet: vi.fn() },
    config: undefined as any,
}))
vi.mock("plaid", async (importOriginal) => {
    const actual = await importOriginal<typeof import("plaid")>()
    return { ...actual, PlaidApi: function (config: unknown) { plaid.config = config; return plaid.api } }
})

const lines: Array<{ event: string; metadata?: Record<string, unknown> }> = []
const logger = createLogger({ logFile: "", serviceName: "test", mode: "development" }, { write: (line: string) => { lines.push(JSON.parse(line)) } })
const gateway = (over: Partial<Parameters<typeof createPlaidGateway>[0]> = {}) =>
    createPlaidGateway({ clientId: "cid", secret: "sekret", env: "sandbox", redirectUri: "", logger, verboseErrors: true, ...over })
const httpError = (data: Record<string, unknown>) => ({ message: "Request failed with status code 400", response: { status: 400, data } })

beforeEach(() => {
    lines.length = 0
    Object.values(plaid.api).forEach((fn) => fn.mockReset())
})

describe("createLinkToken", () => {
    it("asks Plaid for a US bank-auth link for this tenant, and returns the token", async () => {
        plaid.api.linkTokenCreate.mockResolvedValue({ data: { link_token: "link-sandbox-1", request_id: "r1" } })
        expect(await gateway().createLinkToken("tenant:7")).toBe("link-sandbox-1")
        const request = plaid.api.linkTokenCreate.mock.calls[0]![0]
        expect(request).toMatchObject({ user: { client_user_id: "tenant:7" }, products: ["auth"], country_codes: ["US"] })
        expect(request).not.toHaveProperty("redirect_uri")
    })

    it("sends the redirect address only when one is configured", async () => {
        plaid.api.linkTokenCreate.mockResolvedValue({ data: { link_token: "t" } })
        await gateway({ redirectUri: "https://portal.example.com/plaid-oauth" }).createLinkToken("tenant:1")
        expect(plaid.api.linkTokenCreate.mock.calls[0]![0].redirect_uri).toBe("https://portal.example.com/plaid-oauth")
    })

    it("uses the right Plaid host and credentials for the environment", () => {
        gateway({ env: "production" })
        expect(plaid.config.basePath).toBe("https://production.plaid.com")
        expect(plaid.config.baseOptions.headers).toMatchObject({ "PLAID-CLIENT-ID": "cid", "PLAID-SECRET": "sekret" })
        gateway({ env: "sandbox" })
        expect(plaid.config.basePath).toBe("https://sandbox.plaid.com")
    })
})

describe("exchangeAndGetAuth", () => {
    const exchanged = { data: { access_token: "access-sandbox-TOPSECRET", item_id: "item-1", request_id: "r2" } }
    const auth = {
        data: {
            request_id: "r3",
            item: { item_id: "item-1" },
            accounts: [
                { account_id: "a1", name: "Checking", mask: "0000", subtype: "checking" },
                { account_id: "a2", name: "Savings" },
            ],
            numbers: { ach: [{ account_id: "a1", account: "1111222233334444", routing: "011401533" }] },
        },
    }

    it("pairs each account with its bank numbers, and leaves missing ones null", async () => {
        plaid.api.itemPublicTokenExchange.mockResolvedValue(exchanged)
        plaid.api.authGet.mockResolvedValue(auth)
        const result = await gateway().exchangeAndGetAuth("public-sandbox-1")
        expect(plaid.api.authGet).toHaveBeenCalledWith({ access_token: "access-sandbox-TOPSECRET" })
        expect(result.itemId).toBe("item-1")
        expect(result.accounts).toEqual([
            { accountId: "a1", name: "Checking", mask: "0000", subtype: "checking", accountNumber: "1111222233334444", routingNumber: "011401533" },
            { accountId: "a2", name: "Savings", mask: null, subtype: null, accountNumber: null, routingNumber: null },
        ])
    })

    it("never writes the access token or an account number to the log", async () => {
        plaid.api.itemPublicTokenExchange.mockResolvedValue(exchanged)
        plaid.api.authGet.mockResolvedValue(auth)
        await gateway().exchangeAndGetAuth("public-sandbox-1")
        const written = JSON.stringify(lines)
        expect(written).toContain("plaid.request.succeeded")
        expect(written).not.toContain("TOPSECRET")
        expect(written).not.toContain("1111222233334444")
        expect(written).not.toContain("sekret")
    })
})

describe("Plaid failures", () => {
    const failure = httpError({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "login details changed", display_message: null, request_id: "req-9" })

    it("become PLAID_ERROR carrying Plaid's code and request id, and are logged once", async () => {
        plaid.api.linkTokenCreate.mockRejectedValue(failure)
        await expect(gateway().createLinkToken("tenant:1")).rejects.toMatchObject({
            code: "PLAID_ERROR",
            details: { operation: "link_token_create", plaidCode: "ITEM_LOGIN_REQUIRED", plaidType: "ITEM_ERROR", requestId: "req-9", message: "login details changed" },
        })
        expect(lines.filter((l) => l.event === "plaid.request.failed")).toHaveLength(1)
    })

    it("hide Plaid's own wording in production unless Plaid wrote a message for the user", async () => {
        plaid.api.linkTokenCreate.mockRejectedValue(failure)
        await expect(gateway({ verboseErrors: false }).createLinkToken("t")).rejects.toMatchObject({ details: { message: null } })
        plaid.api.linkTokenCreate.mockRejectedValue(httpError({ error_code: "X", display_message: "Try again later", request_id: "r" }))
        await expect(gateway({ verboseErrors: false }).createLinkToken("t")).rejects.toMatchObject({ details: { message: "Try again later" } })
    })

    it("name the step that failed when the second call breaks after the first worked", async () => {
        plaid.api.itemPublicTokenExchange.mockResolvedValue({ data: { access_token: "a", item_id: "i" } })
        plaid.api.authGet.mockRejectedValue(failure)
        await expect(gateway().exchangeAndGetAuth("p")).rejects.toMatchObject({ details: { operation: "auth_get" } })
    })

    it("report a network failure when Plaid never answered", async () => {
        plaid.api.linkTokenCreate.mockRejectedValue({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })
        await expect(gateway().createLinkToken("t")).rejects.toMatchObject({ code: "PLAID_ERROR", details: { plaidType: "NETWORK", plaidCode: "ECONNREFUSED" } })
    })
})
