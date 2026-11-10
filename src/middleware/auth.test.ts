import jwt from "jsonwebtoken"
import { describe, expect, it } from "vitest"

import { currentIdentity } from "../db/identity"
import type { SessionState, ValidRequest } from "../types/access"
import { generateAccessToken } from "../utils/tokens"
import { createAuth } from "./auth"

const config = { accessSecret: "unit-test-secret", jwtIssuer: "portal", jwtAudience: "portal-web", accessTtlSeconds: 900 }

/** The accounts as the database has them now; a test changes one to play a deactivation, reset or demotion. */
const accounts = new Map<string, SessionState>([
    ["tenant:2", { role: "tenant", tokenVersion: 0 }],
    ["tenant:7", { role: "tenant", tokenVersion: 0 }],
    ["admin:3", { role: "admin", tokenVersion: 0 }],
    ["admin:4", { role: "maintenance_staff", tokenVersion: 0 }],
])
const sessions = { findSessionState: async (userId: string) => accounts.get(userId) ?? null }
const { authenticate, can } = createAuth(config, sessions)

const withToken = (token?: string) => ({ cookies: token ? { access_token: token } : {} }) as unknown as ValidRequest
const noop = () => undefined

/** Run a guard chain; resolves to the database identity the handler would run as. */
async function pass(handlers: ReturnType<typeof can>, req: ValidRequest): Promise<unknown> {
    let identity: unknown = "not reached"
    const [first, ...rest] = handlers
    await first!(req, {} as never, () => {
        let i = 0
        const next = () => (i < rest.length ? rest[i++]!(req, {} as never, next) : (identity = currentIdentity()))
        next()
    })
    return identity
}

describe("authenticate", () => {
    it("runs the rest of the request as the token's user", async () => {
        const req = withToken(generateAccessToken(config, "tenant:7", "tenant"))
        let identity: unknown
        await authenticate(req, {} as never, () => { identity = currentIdentity() })
        expect(req.user).toEqual({ id: "tenant:7", role: "tenant" })
        expect(identity).toEqual({ type: "tenant", id: 7 })
    })

    it("refuses no token, a bad audience, and an unknown role", async () => {
        await expect(authenticate(withToken(), {} as never, noop)).rejects.toThrow("UNAUTHENTICATED")
        const wrongAudience = jwt.sign({ sub: "tenant:1", role: "tenant", ver: 0 }, config.accessSecret, { audience: "elsewhere", issuer: "portal" })
        await expect(authenticate(withToken(wrongAudience), {} as never, noop)).rejects.toThrow("INVALID_TOKEN")
        const unknownRole = generateAccessToken(config, "admin:3", "property_manager" as never)
        await expect(authenticate(withToken(unknownRole), {} as never, noop)).rejects.toThrow("INVALID_TOKEN")
    })
})

describe("authenticate checks the account as it is now (012)", () => {
    const refused = async (token: string) => {
        let reached = false
        await expect(authenticate(withToken(token), {} as never, () => { reached = true })).rejects.toThrow("INVALID_TOKEN")
        expect(reached).toBe(false)
    }

    it("refuses a still-unexpired token once the account is deactivated or its sign-in is reset", async () => {
        accounts.set("admin:20", { role: "admin", tokenVersion: 0 })
        const token = generateAccessToken(config, "admin:20", "admin", 0)
        expect(await pass(can("users:provision"), withToken(token))).toEqual({ type: "admin", id: 20, role: "admin" })
        accounts.delete("admin:20")   // findSessionState answers null for both
        await refused(token)
    })

    it("refuses a token issued before a demotion, and the fresh one carries the lesser role", async () => {
        accounts.set("admin:21", { role: "admin", tokenVersion: 0 })
        const old = generateAccessToken(config, "admin:21", "admin", 0)
        accounts.set("admin:21", { role: "maintenance_staff", tokenVersion: 1 })
        await refused(old)
        const fresh = withToken(generateAccessToken(config, "admin:21", "maintenance_staff", 1))
        await expect(pass(can("users:provision"), fresh)).rejects.toThrow("FORBIDDEN")
        expect(await pass(can("maintenance:manage"), fresh)).toEqual({ type: "admin", id: 21, role: "maintenance_staff" })
    })

    it("refuses an old token even after the account is active again (reset, then signed up again)", async () => {
        accounts.set("admin:22", { role: "admin", tokenVersion: 0 })
        const old = generateAccessToken(config, "admin:22", "admin", 0)
        accounts.set("admin:22", { role: "admin", tokenVersion: 1 })
        await refused(old)
    })

    it("refuses a token with no version (issued before 012), and a role the account does not have", async () => {
        const unversioned = jwt.sign({ sub: "admin:3", role: "admin" }, config.accessSecret, { audience: config.jwtAudience, issuer: config.jwtIssuer })
        await refused(unversioned)
        await refused(generateAccessToken(config, "admin:4", "admin", 0))   // admin:4 is maintenance staff
    })

    it("fails the request when the database cannot be asked, rather than trusting the claims", async () => {
        const down = createAuth(config, { findSessionState: async () => { throw new Error("db gone") } })
        let reached = false
        await expect(down.authenticate(withToken(generateAccessToken(config, "admin:3", "admin")), {} as never, () => { reached = true })).rejects.toThrow("db gone")
        expect(reached).toBe(false)
    })
})

describe("can", () => {
    it("lets each role through only to its own permissions", async () => {
        const tenant = withToken(generateAccessToken(config, "tenant:2", "tenant"))
        const admin = withToken(generateAccessToken(config, "admin:3", "admin"))
        expect(await pass(can("payment:create:self"), tenant)).toEqual({ type: "tenant", id: 2 })
        expect(await pass(can("maintenance:manage"), admin)).toEqual({ type: "admin", id: 3, role: "admin" })
        await expect(pass(can("payment:create:self"), admin)).rejects.toThrow("FORBIDDEN")
        await expect(pass(can("users:provision"), tenant)).rejects.toThrow("FORBIDDEN")
    })

    it("gives maintenance staff the maintenance queue and nothing else", async () => {
        const staff = withToken(generateAccessToken(config, "admin:4", "maintenance_staff"))
        expect(await pass(can("maintenance:manage"), staff)).toEqual({ type: "admin", id: 4, role: "maintenance_staff" })
        await expect(pass(can("ledger:read:property"), staff)).rejects.toThrow("FORBIDDEN")
        await expect(pass(can("ledger:adjust"), staff)).rejects.toThrow("FORBIDDEN")
        await expect(pass(can("users:provision"), staff)).rejects.toThrow("FORBIDDEN")
    })

    it("a staff role on a tenant id (or the reverse) matches no account", async () => {
        const mixed = withToken(generateAccessToken(config, "tenant:2", "maintenance_staff"))
        await expect(pass(can("maintenance:manage"), mixed)).rejects.toThrow("INVALID_TOKEN")
    })
})
