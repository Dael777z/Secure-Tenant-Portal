import { describe, expect, it } from "vitest"

import { isLocalOrigin, loadConfig } from "./config"

/**
 * Development mode signs sessions with a secret that is printed in the source code.
 * That is fine on this machine and an open door anywhere else, so a public address
 * needs real secrets (or production mode, which has its own checks).
 */
describe("development mode on a public address", () => {
    const PUBLIC = { NODE_ENV: "development", WEB_ORIGIN: "https://portal.example.com" }
    const SECRET = "s".repeat(32)

    it("knows which addresses are this machine", () => {
        for (const ok of ["http://localhost", "http://localhost:5173", "http://127.0.0.1:3000"]) expect(isLocalOrigin(ok), ok).toBe(true)
        for (const bad of ["https://portal.example.com", "http://portal.example.com", "http://localhost.evil.com", "http://127.0.0.1.evil.com", "https://localhost", ""]) expect(isLocalOrigin(bad), bad).toBe(false)
    })

    it("refuses to start on a public address without a real JWT secret", () => {
        expect(() => loadConfig(PUBLIC)).toThrow("JWT_ACCESS_SECRET must be set")
        expect(() => loadConfig({ ...PUBLIC, JWT_ACCESS_SECRET: "too-short" })).toThrow("JWT_ACCESS_SECRET must be set")
    })

    it("starts with a real secret, and signs with it rather than the public one", () => {
        const config = loadConfig({ ...PUBLIC, JWT_ACCESS_SECRET: SECRET })
        expect(config.accessSecret).toBe(SECRET)
    })

    it("needs a real token-encryption key too when Plaid is on", () => {
        const plaid = { ...PUBLIC, JWT_ACCESS_SECRET: SECRET, PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret" }
        expect(() => loadConfig(plaid)).toThrow("TOKEN_ENCRYPTION_KEY must be set")
        expect(loadConfig({ ...plaid, TOKEN_ENCRYPTION_KEY: "k".repeat(32) }).tokenEncryptionKey).toBe("k".repeat(32))
    })

    it("still works with no secrets on this machine, in tests, and for the database tools", () => {
        expect(loadConfig({ NODE_ENV: "development" }).accessSecret).toContain("development-only")
        expect(loadConfig({ NODE_ENV: "development", WEB_ORIGIN: "http://localhost:3000" }).webOrigin).toBe("http://localhost:3000")
        expect(() => loadConfig({ NODE_ENV: "test", WEB_ORIGIN: "https://portal.example.com" })).not.toThrow()
        expect(() => loadConfig(PUBLIC, { server: false })).not.toThrow()
    })

    it("production mode is unchanged: it still demands a long secret and an https address", () => {
        expect(() => loadConfig({ NODE_ENV: "production", WEB_ORIGIN: "https://portal.example.com" })).toThrow("JWT_ACCESS_SECRET")
        expect(() => loadConfig({ NODE_ENV: "production", JWT_ACCESS_SECRET: SECRET, WEB_ORIGIN: "http://portal.example.com" })).toThrow("WEB_ORIGIN")
        expect(loadConfig({ NODE_ENV: "production", JWT_ACCESS_SECRET: SECRET, WEB_ORIGIN: "https://portal.example.com" }).production).toBe(true)
    })
})
