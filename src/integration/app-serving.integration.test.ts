import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { Client, listen } from "./http-client"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/** The built frontend served by the same app (production), and the health probes Docker uses. */
const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("serving the built frontend and health probes", () => {
    let t: TestDatabase
    let container: Container
    const closers: Array<() => Promise<void>> = []
    let site: Client
    let brokenDb: Client

    beforeAll(async () => {
        t = await freshDatabase("it_app_serving")
        await seed(t.owner, { dataset: "clean", webOrigin: config.webOrigin, bcryptRounds: 4 })
        const dist = mkdtempSync(join(tmpdir(), "portal-dist-"))
        mkdirSync(join(dist, "assets"))
        writeFileSync(join(dist, "index.html"), "<!doctype html><title>Portal SPA</title>")
        writeFileSync(join(dist, "assets", "app.js"), "console.log('app')")

        container = createContainer({ config, db: t.db, plaid: null, distRoot: dist })
        const up = await listen(createApp(container))
        const down = await listen(createApp({ ...container, health: { checkHealth: async () => { throw new Error("db gone") } } }))
        closers.push(up.close, down.close)
        site = new Client(up.host, config.webOrigin)
        brokenDb = new Client(down.host, config.webOrigin)
    })
    afterAll(async () => {
        await Promise.all(closers.map((close) => close()))
        await container?.close()
        await t?.drop()
    })

    it("serves real files as they are", async () => {
        const res = await site.get("/assets/app.js")
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toMatch(/javascript/)
        expect(res.bytes.toString()).toBe("console.log('app')")
    })

    it("any other page address gets the app itself, so deep links and refreshes work", async () => {
        for (const path of ["/", "/tenant/pay", "/manager/leases/12"]) {
            const res = await site.get(path)
            expect(res.status, path).toBe(200)
            expect(res.headers.get("content-type")).toMatch(/html/)
            expect(res.bytes.toString()).toContain("Portal SPA")
        }
    })

    it("an unknown API path is still a JSON 404, never the app", async () => {
        const res = await site.get("/api/does-not-exist")
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: "NOT_FOUND" })
    })

    it("/health/ready is 200 when the database answers and 503 when it does not; /health/live always answers", async () => {
        expect((await site.get("/health/ready")).status).toBe(200)
        const down = await brokenDb.get("/health/ready")
        expect(down.status).toBe(503)
        expect(down.body).toEqual({ ok: false })
        expect((await brokenDb.get("/health/live")).status).toBe(200)
    })
})
