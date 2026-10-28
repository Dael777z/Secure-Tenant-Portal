import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Application } from "express"
import jwt from "jsonwebtoken"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"
import { ACCOUNTS, Client } from "./http-client"

/**
 * API sweep: one table-driven test over EVERY route the app registers.
 *
 * The routes are read from the running Express app, so a new route is covered
 * the moment it exists. It must also be classified in `allowedFor` below; a
 * route nobody classified fails the first test, so access rules cannot be
 * forgotten. Checks per route: the wrong caller is refused (401 / 403), forged
 * or expired tokens are refused, a foreign Origin cannot write, and the right
 * caller never gets a server error, even from empty, hostile or malformed input.
 *
 * Needs TEST_DATABASE_URL (skipped without it, like the other integration tests).
 */
const config = loadConfig({ NODE_ENV: "test" })

type Who = "anonymous" | "tenant" | "admin" | "maintenance"
const EVERYONE: Who[] = ["anonymous", "tenant", "admin", "maintenance"]

interface Route { method: string; path: string }
const label = (r: Route) => `${r.method} ${r.path}`

/** Routes that anyone may call (sign-in itself, health probes). Everything else needs a session. */
const PUBLIC = new Set(["POST /api/auth/signup", "POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout", "GET /health/live", "GET /health/ready"])

/** Who may call a route. `null` means nobody classified it yet: add a rule here. */
function allowedFor(route: Route): Who[] | null {
    const { path } = route
    if (PUBLIC.has(label(route))) return EVERYONE
    if (path === "/api/auth/me") return ["tenant", "admin", "maintenance"]
    if (path.startsWith("/api/tenant/") || path === "/api/create_link_token" || path === "/api/exchange_and_get_auth") return ["tenant"]
    if (path === "/api/manager/me" || path.startsWith("/api/manager/maintenance")) return ["admin", "maintenance"]
    if (path.startsWith("/api/manager/")) return ["admin"]
    return null
}

/** Every route registered on the app. Routers are all mounted at /api; direct routes (health) are not. */
function listRoutes(app: Application): Route[] {
    const out: Route[] = []
    const walk = (stack: any[], prefix: string) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path })
            } else if (Array.isArray(layer.handle?.stack)) {
                walk(layer.handle.stack, "/api")
            }
        }
    }
    walk((app as any).router.stack, "")
    return out
}

const concrete = (path: string, id = "999999") => path.replace(/:\w+/g, id)

describe.skipIf(!hasDatabase)("API sweep: every route, every role", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let routes: Route[]
    let host: string
    const clients = {} as Record<Who, Client>

    beforeAll(async () => {
        t = await freshDatabase("it_api_sweep")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        const app = createApp(container)
        routes = listRoutes(app)
        server = app.listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

        clients.anonymous = new Client(host, config.webOrigin)
        for (const who of ["tenant", "admin", "maintenance"] as const) {
            clients[who] = new Client(host, config.webOrigin)
            const login = await clients[who].call("POST", "/api/auth/login", { body: ACCOUNTS[who] })
            expect(login.status, `${who} can sign in`).toBe(200)
        }
    })
    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        await container?.close()
        await t?.drop()
    })

    const protectedRoutes = () => routes.filter((r) => !PUBLIC.has(label(r)))

    it("finds the routes and every one is classified", () => {
        expect(routes.length, "route discovery found the app's routes").toBeGreaterThan(50)
        const unclassified = routes.filter((r) => allowedFor(r) === null).map(label)
        expect(unclassified, "add these to allowedFor() in api-sweep.integration.test.ts").toEqual([])
    })

    it("refuses every caller who is not allowed: 401 without a session, 403 with the wrong role", async () => {
        const failures: string[] = []
        for (const route of protectedRoutes()) {
            const allowed = allowedFor(route)!
            for (const who of EVERYONE.filter((w) => !allowed.includes(w))) {
                const res = await clients[who].call(route.method, concrete(route.path), { body: route.method === "GET" ? undefined : {} })
                const expected = who === "anonymous" ? 401 : 403
                if (res.status !== expected) failures.push(`${who} ${label(route)} -> ${res.status}, expected ${expected}`)
            }
        }
        expect(failures).toEqual([])
    })

    it("refuses forged, unsigned and expired access tokens on every protected route", async () => {
        const claims = { sub: "admin:1", role: "admin" }
        const opts = { issuer: config.jwtIssuer, audience: config.jwtAudience }
        const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
        const tokens = {
            "wrong secret": jwt.sign(claims, "not-the-secret", { algorithm: "HS256", ...opts }),
            "alg none": `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...claims, ...opts, iss: opts.issuer, aud: opts.audience })}.`,
            "expired": jwt.sign(claims, config.accessSecret, { algorithm: "HS256", expiresIn: -60, ...opts }),
            "wrong audience": jwt.sign(claims, config.accessSecret, { algorithm: "HS256", issuer: opts.issuer, audience: "someone-else" }),
            "garbage": "not.a.token",
        }
        const failures: string[] = []
        for (const [name, token] of Object.entries(tokens)) {
            for (const route of protectedRoutes()) {
                const res = await clients.anonymous.call(route.method, concrete(route.path), { cookie: `access_token=${token}`, body: route.method === "GET" ? undefined : {} })
                if (res.status !== 401) failures.push(`${name}: ${label(route)} -> ${res.status}`)
            }
        }
        expect(failures).toEqual([])
    })

    it("refuses a write from a foreign Origin on every write route, even for a signed-in admin", async () => {
        const failures: string[] = []
        for (const route of routes.filter((r) => r.method !== "GET")) {
            const res = await clients.admin.call(route.method, concrete(route.path), { body: {}, headers: { origin: "https://evil.example" } })
            if (res.status !== 403) failures.push(`${label(route)} -> ${res.status}`)
        }
        expect(failures).toEqual([])
    })

    it("never answers an allowed caller with a server error, whatever the input", async () => {
        const inputs: Array<[string, (r: Route) => { path: string; body?: unknown }]> = [
            ["unknown id, empty body", (r) => ({ path: concrete(r.path), body: r.method === "GET" ? undefined : {} })],
            ["non-numeric id, hostile body", (r) => ({ path: concrete(r.path, "abc"), body: r.method === "GET" ? undefined : { amount: -1, id: "1; DROP TABLE Payment", email: 7, text: "x".repeat(5000), kind: { $ne: null } } })],
        ]
        const failures: string[] = []
        for (const route of protectedRoutes()) {
            const who = allowedFor(route)!.find((w) => w !== "anonymous")!
            for (const [name, build] of inputs) {
                const { path, body } = build(route)
                const res = await clients[who].call(route.method, path, { body })
                const acceptable = res.status < 500 || (res.status === 503 && res.body.error === "PLAID_NOT_CONFIGURED")
                if (!acceptable || res.status === 401 || res.status === 403) failures.push(`${who} ${label(route)} [${name}] -> ${res.status} ${JSON.stringify(res.body).slice(0, 80)}`)
            }
        }
        expect(failures).toEqual([])
    })

    it("answers a malformed JSON body with a 400, not a 500", async () => {
        const failures: string[] = []
        for (const route of protectedRoutes().filter((r) => r.method !== "GET")) {
            const who = allowedFor(route)!.find((w) => w !== "anonymous")!
            const res = await clients[who].call(route.method, concrete(route.path), { body: "{not json" })
            if (res.status !== 400) failures.push(`${who} ${label(route)} -> ${res.status}`)
        }
        expect(failures).toEqual([])
    })

    it("sends no-store and hardening headers on API answers and hides the framework", async () => {
        const res = await clients.anonymous.call("GET", "/api/auth/me")
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(res.headers.get("x-content-type-options")).toBe("nosniff")
        expect(res.headers.get("x-powered-by")).toBeNull()
    })

    it("answers the health probes", async () => {
        expect((await clients.anonymous.call("GET", "/health/live")).status).toBe(200)
        expect((await clients.anonymous.call("GET", "/health/ready")).status).toBe(200)
    })
})
