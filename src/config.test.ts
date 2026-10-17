import { describe, expect, it } from "vitest"

import { loadConfig } from "./config"

describe("loadConfig", () => {
    it("needs nothing in development: database logins default to the dev container's", () => {
        const config = loadConfig({})
        expect(config.mode).toBe("development")
        expect(config.databaseUrl).toBe("postgres://summit_app:summit-dev-only@localhost:5432/portal")
        expect(config.databaseAdminUrl).toBe("postgres://portal:portal-dev-only@localhost:5432/portal")
        expect(config.secureCookies).toBe(false)
    })

    it("builds the URLs from the parts Docker sets, escaping passwords", () => {
        const config = loadConfig({ DB_HOST: "db", APP_DB_PASSWORD: "p@ss/word", POSTGRES_PASSWORD: "x" })
        expect(config.databaseUrl).toBe("postgres://summit_app:p%40ss%2Fword@db:5432/portal")
        expect(new URL(config.databaseUrl).password).toBe("p%40ss%2Fword")
    })

    it("a full DATABASE_URL wins over the parts", () => {
        expect(loadConfig({ DATABASE_URL: "postgres://summit_app:a@elsewhere:6543/x" }).databaseUrl).toBe("postgres://summit_app:a@elsewhere:6543/x")
    })

    it("production has no defaults for secrets, and says everything that is missing at once", () => {
        expect(() => loadConfig({ NODE_ENV: "production", WEB_ORIGIN: "http://portal.example.com" })).toThrow(
            /JWT_ACCESS_SECRET must be set[\s\S]*WEB_ORIGIN must be an https:\/\/ address/,
        )
        const config = loadConfig({ NODE_ENV: "production", JWT_ACCESS_SECRET: "s".repeat(32), WEB_ORIGIN: "http://localhost:8080" })
        expect(config.secureCookies).toBe(true)
        expect(config.databaseUrl).toBe("")   // no APP_DB_PASSWORD: the server refuses to start
    })
})
