import jwt from "jsonwebtoken"
import { describe, expect, it } from "vitest"

import { currentIdentity } from "../db/identity"
import type { ValidRequest } from "../types/access"
import { generateAccessToken } from "../utils/tokens"
import { createAuth } from "./auth"

const config = { accessSecret: "unit-test-secret", jwtIssuer: "portal", jwtAudience: "portal-web", accessTtlSeconds: 900 }
const { authenticate, can } = createAuth(config)

const withToken = (token?: string) => ({ cookies: token ? { access_token: token } : {} }) as unknown as ValidRequest

/** Run a guard chain; returns the database identity the handler would run as. */
function pass(handlers: ReturnType<typeof can>, req: ValidRequest): unknown {
    let identity: unknown = "not reached"
    const [first, ...rest] = handlers
    first!(req, {} as never, () => {
        let i = 0
        const next = () => (i < rest.length ? rest[i++]!(req, {} as never, next) : (identity = currentIdentity()))
        next()
    })
    return identity
}

describe("authenticate", () => {
    it("runs the rest of the request as the token's user", () => {
        const req = withToken(generateAccessToken(config, "tenant:7", "tenant"))
        let identity: unknown
        authenticate(req, {} as never, () => { identity = currentIdentity() })
        expect(req.user).toEqual({ id: "tenant:7", role: "tenant" })
        expect(identity).toEqual({ type: "tenant", id: 7 })
    })

    it("refuses no token, a bad audience, and an unknown role", () => {
        expect(() => authenticate(withToken(), {} as never, () => undefined)).toThrow("UNAUTHENTICATED")
        const wrongAudience = jwt.sign({ sub: "tenant:1", role: "tenant" }, config.accessSecret, { audience: "elsewhere", issuer: "portal" })
        expect(() => authenticate(withToken(wrongAudience), {} as never, () => undefined)).toThrow("INVALID_TOKEN")
        const unknownRole = generateAccessToken(config, "admin:1", "property_manager" as never)
        expect(() => authenticate(withToken(unknownRole), {} as never, () => undefined)).toThrow("INVALID_TOKEN")
    })
})

describe("can", () => {
    it("lets each role through only to its own permissions", () => {
        const tenant = withToken(generateAccessToken(config, "tenant:2", "tenant"))
        const admin = withToken(generateAccessToken(config, "admin:3", "admin"))
        expect(pass(can("payment:create:self"), tenant)).toEqual({ type: "tenant", id: 2 })
        expect(pass(can("maintenance:manage"), admin)).toEqual({ type: "admin", id: 3, role: "admin" })
        expect(() => pass(can("payment:create:self"), admin)).toThrow("FORBIDDEN")
        expect(() => pass(can("users:provision"), tenant)).toThrow("FORBIDDEN")
    })

    it("gives maintenance staff the maintenance queue and nothing else", () => {
        const staff = withToken(generateAccessToken(config, "admin:4", "maintenance_staff"))
        expect(pass(can("maintenance:manage"), staff)).toEqual({ type: "admin", id: 4, role: "maintenance_staff" })
        expect(() => pass(can("ledger:read:property"), staff)).toThrow("FORBIDDEN")
        expect(() => pass(can("ledger:adjust"), staff)).toThrow("FORBIDDEN")
        expect(() => pass(can("users:provision"), staff)).toThrow("FORBIDDEN")
    })

    it("treats a staff role on a tenant id (or the reverse) as nobody", () => {
        const mixed = withToken(generateAccessToken(config, "tenant:2", "maintenance_staff"))
        expect(pass(can("maintenance:manage"), mixed)).toEqual({ type: "anonymous" })
    })
})
