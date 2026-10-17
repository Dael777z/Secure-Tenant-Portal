import { describe, expect, it } from "vitest"
import jwt from "jsonwebtoken"

import { generateAccessToken, hashToken, newInvite, randomToken } from "./tokens"

const config = { accessSecret: "unit-test-secret", jwtIssuer: "portal", jwtAudience: "portal-web", accessTtlSeconds: 900 }

describe("access token claims", () => {
    it("includes and requires the configured issuer and audience", () => {
        const token = generateAccessToken(config, "tenant:1", "tenant")
        const decoded = jwt.verify(token, config.accessSecret, {
            algorithms: ["HS256"],
            audience: config.jwtAudience,
            issuer: config.jwtIssuer,
        })

        expect(decoded).toMatchObject({ sub: "tenant:1", role: "tenant" })
    })
})

describe("random tokens", () => {
    it("differ every time, and the stored hash fits the schema's CHECK (64 lowercase hex)", () => {
        const a = randomToken()
        const b = randomToken()
        expect(a.token).not.toBe(b.token)
        expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hashToken(a.token)).toBe(a.hash)
    })

    it("an invitation keeps only the hash, and expires in a week", () => {
        const { token, invite } = newInvite()
        expect(invite.tokenHash).toBe(hashToken(token))
        expect(invite.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000)
    })
})
