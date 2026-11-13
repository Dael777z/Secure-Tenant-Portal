import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { configFromEnvironment, loadConfig } from "./config"
import { createContainer } from "./container"
import { createPool } from "./db/pool"
import { createLogger } from "./logging"

// Start-up wiring: settings, log file, database pool and the container. No database needed.
const base = loadConfig({ NODE_ENV: "test" })
const NOWHERE = "postgres://summit_app:x@127.0.0.1:1/portal"   // nothing listens on port 1
afterEach(() => { vi.restoreAllMocks() })

describe("settings problems are reported clearly", () => {
    it("a port that is not a number, and a negative proxy count", () => {
        expect(() => loadConfig({ PORT: "abc" })).toThrow("PORT must be a port number")
        expect(() => loadConfig({ TRUST_PROXY_HOPS: "-1" })).toThrow("TRUST_PROXY_HOPS must be 0 or more")
    })
    it("production with Plaid on needs a key to encrypt bank tokens", () => {
        const production = { NODE_ENV: "production", JWT_ACCESS_SECRET: "s".repeat(32), WEB_ORIGIN: "https://portal.example.com", APP_DB_PASSWORD: "a", POSTGRES_PASSWORD: "b" }
        expect(() => loadConfig({ ...production, PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret" })).toThrow("TOKEN_ENCRYPTION_KEY must be set when Plaid is on")
        expect(loadConfig({ ...production, PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret", TOKEN_ENCRYPTION_KEY: "k".repeat(32) }).production).toBe(true)
    })
    it("configFromEnvironment reads the process environment (vitest runs as NODE_ENV=test)", () => {
        const config = configFromEnvironment()
        expect(config.mode).toBe("test")
        expect(Number.isInteger(config.port)).toBe(true)
    })
})

describe("log file", () => {
    it("writes JSON lines to the file as well as the console, creating its folder", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "portal-log-")), "nested", "app.log")
        const logger = createLogger({ logFile: file, serviceName: "test", mode: "development" }, { write: () => undefined })
        logger.info("startup.check", { ok: true })
        let text = ""
        for (let i = 0; i < 20 && !text; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            try { text = readFileSync(file, "utf8") } catch { /* not flushed yet */ }
        }
        expect(JSON.parse(text.trim().split("\n")[0]!)).toMatchObject({ event: "startup.check", service: "test" })
    })
})

describe("database pool", () => {
    it("reports a lost connection instead of crashing the process", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const pool = createPool(NOWHERE)
        pool.emit("error", new Error("boom"))
        expect(spy).toHaveBeenCalledWith("database connection lost: boom")
        await pool.end()
    })
})

describe("createContainer", () => {
    it("refuses to start without a database login", () => {
        expect(() => createContainer({ config: { ...base, databaseUrl: "" }, plaid: null })).toThrow("No database login for the app")
    })
    it("the start-up check says Postgres is not running when nothing answers", async () => {
        const container = createContainer({ config: { ...base, databaseUrl: NOWHERE }, plaid: null })
        await expect(container.checkDatabase()).rejects.toThrow("Postgres is not running at the DATABASE_URL address.")
        await container.close()
    })
    it("turns Plaid on only when both keys are set", async () => {
        const off = createContainer({ config: { ...base, databaseUrl: NOWHERE, plaidClientId: "", plaidSecret: "" } })
        const on = createContainer({ config: { ...base, databaseUrl: NOWHERE, plaidClientId: "id", plaidSecret: "secret" } })
        expect(off.plaid).toBeNull()
        expect(on.plaid).not.toBeNull()
        await Promise.all([off.close(), on.close()])
    })
    it("with a database handed in, there is no pool to check or close", async () => {
        const container = createContainer({ config: base, db: {} as never, plaid: null })
        await expect(container.checkDatabase()).resolves.toBeUndefined()
        await expect(container.close()).resolves.toBeUndefined()
    })
})
