import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import express, { type Express } from "express"
import { afterEach, describe, expect, it } from "vitest"

import { createLogger } from "../logging"
import { AppError } from "../types/errors"
import { errorHandler } from "./errors"
import { verifyRequestOrigin } from "./origin"
import { createRateLimits } from "./rate-limit"
import { privateApiCache, securityHeaders } from "./security"

// Each middleware on a tiny app of its own: no database, real HTTP.
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))) })

async function serve(build: (app: Express) => void) {
    const app = express()
    build(app)
    const server = app.listen(0)
    servers.push(server)
    await new Promise((resolve) => server.once("listening", resolve))
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return (path: string, init?: RequestInit) => fetch(host + path, init)
}
const lines: Array<{ event: string; level: number }> = []
const logger = createLogger({ logFile: "", serviceName: "test", mode: "development" }, { write: (line: string) => { lines.push(JSON.parse(line)) } })
const json = { "content-type": "application/json" }

describe("errorHandler", () => {
    it("answers an AppError with its status, code and details", async () => {
        const call = await serve((app) => {
            app.get("/x", () => { throw new AppError("UNIT_OCCUPIED", { unitId: 4 }) })
            app.use(errorHandler(logger))
        })
        const res = await call("/x")
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: "UNIT_OCCUPIED", details: { unitId: 4 } })
    })

    it("answers anything unexpected with a bare 500 and logs the cause, without leaking it", async () => {
        lines.length = 0
        const call = await serve((app) => {
            app.get("/x", () => { throw new Error("password=hunter2 in SELECT ...") })
            app.use(errorHandler(logger))
        })
        const res = await call("/x")
        expect(res.status).toBe(500)
        expect(await res.text()).toBe('{"error":"INTERNAL_SERVER_ERROR"}')
        expect(lines.find((l) => l.event === "request.failed")?.level).toBe(50)
    })

    it("answers a malformed JSON body with 400, not 500", async () => {
        const call = await serve((app) => {
            app.use(express.json())
            app.post("/x", (_req, res) => { res.json({ ok: true }) })
            app.use(errorHandler(logger))
        })
        const res = await call("/x", { method: "POST", headers: json, body: "{not json" })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: "VALIDATION_ERROR" })
    })

    it("answers a body over the size limit with 413, not 500", async () => {
        const call = await serve((app) => {
            app.use(express.json({ limit: "1kb" }))
            app.post("/x", (_req, res) => { res.json({ ok: true }) })
            app.use(errorHandler(logger))
        })
        const res = await call("/x", { method: "POST", headers: json, body: JSON.stringify({ pad: "x".repeat(5000) }) })
        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ error: "PAYLOAD_TOO_LARGE" })
    })
})

describe("verifyRequestOrigin", () => {
    const origin = "https://portal.example.com"
    const app = (a: Express) => {
        a.use(verifyRequestOrigin(origin))
        a.all("/x", (_req, res) => { res.json({ ok: true }) })
        a.use(errorHandler(logger))
    }
    it("lets a write from the portal's own origin through", async () => {
        const call = await serve(app)
        expect((await call("/x", { method: "POST", headers: { origin } })).status).toBe(200)
    })
    it("refuses a write from another origin, for every write method", async () => {
        const call = await serve(app)
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            expect((await call("/x", { method, headers: { origin: "https://evil.example" } })).status, method).toBe(403)
        }
    })
    it("never blocks reads", async () => {
        const call = await serve(app)
        expect((await call("/x", { headers: { origin: "https://evil.example" } })).status).toBe(200)
    })
    // Documents current behaviour: a write with NO Origin header is allowed (scripts, curl). Browsers
    // always send Origin on cross-site writes, and the session cookies are SameSite.
    it("lets a write with no Origin header through", async () => {
        const call = await serve(app)
        expect((await call("/x", { method: "POST" })).status).toBe(200)
    })
})

describe("securityHeaders and privateApiCache", () => {
    const build = (options: { production: boolean; https: boolean }) => (a: Express) => {
        a.use(securityHeaders(options))
        a.use(privateApiCache)
        a.get("/api/x", (_req, res) => { res.json({}) })
        a.get("/page", (_req, res) => { res.send("hi") })
    }
    it("always: nosniff, a strict referrer policy and no framework banner", async () => {
        const res = await (await serve(build({ production: false, https: false })))("/page")
        expect(res.headers.get("x-content-type-options")).toBe("nosniff")
        expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
        expect(res.headers.get("x-powered-by")).toBeNull()
    })
    it("development: no content-security-policy (Vite needs inline scripts) and no HSTS", async () => {
        const res = await (await serve(build({ production: false, https: false })))("/page")
        expect(res.headers.get("content-security-policy")).toBeNull()
        expect(res.headers.get("strict-transport-security")).toBeNull()
    })
    it("production over https: locked-down CSP that still allows Plaid, plus HSTS", async () => {
        const res = await (await serve(build({ production: true, https: true })))("/page")
        const csp = res.headers.get("content-security-policy")!
        expect(csp).toContain("default-src 'self'")
        expect(csp).toContain("frame-ancestors 'none'")
        expect(csp).toContain("object-src 'none'")
        expect(csp).toMatch(/script-src 'self' https:\/\/cdn\.plaid\.com/)
        expect(csp).toContain("upgrade-insecure-requests")
        expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000")
    })
    it("production over plain http (behind a tunnel): CSP but no HSTS and no forced upgrade", async () => {
        const res = await (await serve(build({ production: true, https: false })))("/page")
        expect(res.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests")
        expect(res.headers.get("strict-transport-security")).toBeNull()
    })
    it("API answers are never cached; pages are left alone", async () => {
        const call = await serve(build({ production: false, https: false }))
        expect((await call("/api/x")).headers.get("cache-control")).toBe("no-store")
        expect((await call("/page")).headers.get("cache-control")).toBeNull()
    })
})

describe("createRateLimits", () => {
    const app = (a: Express) => {
        const limits = createRateLimits({ rateLimits: { login: 2, signup: 5, refresh: 1, sensitive: 5, messages: 5 } })   // fresh counters per app
        a.get("/login", limits.login, (_req, res) => { res.json({ ok: true }) })
        a.get("/refresh", limits.refresh, (_req, res) => { res.json({ ok: true }) })
    }
    it("answers 429 RATE_LIMITED once the limit is used up, and says so in headers", async () => {
        const call = await serve(app)
        expect((await call("/login")).status).toBe(200)
        expect((await call("/login")).status).toBe(200)
        const blocked = await call("/login")
        expect(blocked.status).toBe(429)
        expect(await blocked.json()).toEqual({ error: "RATE_LIMITED" })
        expect(blocked.headers.has("ratelimit") || blocked.headers.has("ratelimit-policy")).toBe(true)
        expect(blocked.headers.get("x-ratelimit-limit")).toBeNull()   // legacy headers are off
    })
    it("each kind of request has its own allowance", async () => {
        const call = await serve(app)
        expect((await call("/refresh")).status).toBe(200)
        expect((await call("/refresh")).status).toBe(429)
        expect((await call("/login")).status).toBe(200)
    })
})
