import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { createStaffAccount } from "../db/admin"
import { checkDatabase, migrate, setAppLogin } from "../db/migrate"
import { seed } from "../db/seed"
import { DATASETS, VACANT } from "../db/seed/data"
import { withServerLock, freshDatabase, hasDatabase, TEST_ADMIN_URL, type TestDatabase } from "./helpers"

/** The command-line side: migrations, the app login, the start-up check, staff accounts and seeding. */
const dbUrl = (name: string) => { const u = new URL(TEST_ADMIN_URL); u.pathname = `/${name}`; return u.toString() }
const sqlDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "portal-migrations-"))
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
    return dir
}

describe.skipIf(!hasDatabase)("database tools", () => {
    let t: TestDatabase          // fully migrated (also creates the cluster-wide summit_app role)
    let scratch: Pool            // an empty database
    const dirs: string[] = []

    beforeAll(async () => {
        t = await freshDatabase("it_tools")
        const admin = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 })
        for (const name of ["it_tools_empty", "it_tools_migrate"]) {
            await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
            await admin.query(`CREATE DATABASE ${name}`)
        }
        await admin.end()
        scratch = new Pool({ connectionString: dbUrl("it_tools_empty"), max: 2 })
    })
    afterAll(async () => {
        await scratch?.end()
        const admin = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 })
        for (const name of ["it_tools_empty", "it_tools_migrate"]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await admin.end()
        await t?.drop()
        dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
    })
    afterEach(() => { vi.restoreAllMocks() })

    describe("migrate", () => {
        it("stops at a broken file, names it, and leaves earlier files applied", async () => {
            const pool = new Pool({ connectionString: dbUrl("it_tools_migrate"), max: 1 })
            try {
                const dir = sqlDir({ "001_ok.sql": "CREATE TABLE tools_a (x int);", "002_bad.sql": "SELECT nope_not_a_function();" })
                dirs.push(dir)
                await expect(migrate(pool, dir)).rejects.toThrow("002_bad.sql failed:")
                expect((await pool.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)).toEqual(["001_ok.sql"])
                expect((await pool.query("SELECT to_regclass('tools_a') IS NOT NULL AS ok")).rows[0].ok).toBe(true)
            } finally {
                await pool.end()
            }
        })

        it("refuses a database that has a migration this checkout no longer has", async () => {
            const pool = new Pool({ connectionString: dbUrl("it_tools_migrate"), max: 1 })
            try {
                const empty = sqlDir({})
                dirs.push(empty)
                await expect(migrate(pool, empty)).rejects.toThrow("001_ok.sql is not a file")
            } finally {
                await pool.end()
            }
        })
    })

    describe("setAppLogin", () => {
        it("only sets a password for summit_app, and only when a URL with a password is given", async () => {
            expect(await setAppLogin(t.owner, "")).toBe(false)
            expect(await setAppLogin(t.owner, "postgres://someone_else:pw@localhost/db")).toBe(false)
            expect(await setAppLogin(t.owner, "postgres://summit_app@localhost/db")).toBe(false)
            expect(await withServerLock(() => setAppLogin(t.owner, t.appUrl))).toBe(true)
        })
    })

    describe("start-up check messages", () => {
        it("Postgres not running", async () => {
            const pool = new Pool({ connectionString: "postgres://summit_app:x@127.0.0.1:1/db", max: 1 })
            await expect(checkDatabase(pool)).rejects.toThrow("Postgres is not running")
            await pool.end()
        })
        it("database does not exist", async () => {
            const pool = new Pool({ connectionString: dbUrl("it_tools_no_such_db"), max: 1 })
            await expect(checkDatabase(pool)).rejects.toThrow("does not exist yet")
            await pool.end()
        })
        it("no tables yet", async () => {
            await expect(checkDatabase(scratch)).rejects.toThrow("no tables yet")
        })
        it("the app login cannot read the migrations table", async () => {
            await t.owner.query("REVOKE SELECT ON schema_migrations FROM summit_app")
            try {
                await expect(checkDatabase(t.app)).rejects.toThrow("cannot read schema_migrations")
            } finally {
                await t.owner.query("GRANT SELECT ON schema_migrations TO summit_app")
            }
        })
    })

    describe("createStaffAccount", () => {
        const account = (over: Partial<Parameters<typeof createStaffAccount>[1]> = {}) =>
            ({ email: "tools.admin@example.com", name: "Tools Admin", password: "a-long-password", bcryptRounds: 4, ...over })

        it("makes a manager or a maintenance login", async () => {
            await createStaffAccount(t.owner, account())
            await createStaffAccount(t.owner, account({ email: "tools.maint@example.com", role: "maintenance_staff" }))
            const roles = (await t.owner.query("SELECT email, role FROM Admin ORDER BY email")).rows
            expect(roles).toEqual([{ email: "tools.admin@example.com", role: "admin" }, { email: "tools.maint@example.com", role: "maintenance_staff" }])
        })
        it("says what is wrong: short password, taken email, not an email, no tables", async () => {
            await expect(createStaffAccount(t.owner, account({ password: "short" }))).rejects.toThrow("at least 8 characters")
            await expect(createStaffAccount(t.owner, account())).rejects.toThrow("already has an account")
            await expect(createStaffAccount(t.owner, account({ email: "not-an-email" }))).rejects.toThrow("is not an email address")
            await expect(createStaffAccount(scratch, account({ email: "x@example.com" }))).rejects.toThrow("no tables yet")
        })
    })

    describe("seed", () => {
        const dataWith = (property: Record<string, unknown>) => ({
            staff: [{ name: "Seed Admin", email: "seed.admin@example.com" }],
            properties: [{ name: "Seed Court", address: "1 Seed St", units: { "101": VACANT }, ...property }],
        }) as never
        const failsAndRollsBack = async (property: Record<string, unknown>, message: string) => {
            vi.spyOn(DATASETS, "clean").mockReturnValue(dataWith(property))
            const db = await freshDatabase("it_seed_errors")
            try {
                await expect(seed(db.owner, { dataset: "clean", webOrigin: "http://localhost:5173", bcryptRounds: 4 })).rejects.toThrow(message)
                expect((await db.owner.query("SELECT count(*)::int AS n FROM Admin")).rows[0].n).toBe(0)   // nothing half-written
            } finally {
                await db.drop()
            }
        }
        it("rejects maintenance for a unit the property does not have, and writes nothing", () =>
            failsAndRollsBack({ maintenance: [{ unit: "999", title: "x", status: "submitted", filed: "2026-10-01" }] }, "maintenance for unit 999"))
        it("rejects maintenance filed by someone who is not a tenant", () =>
            failsAndRollsBack({ maintenance: [{ unit: "101", by: "ghost@example.com", title: "x", status: "submitted", filed: "2026-10-01" }] }, "who is not a tenant"))
        it("rejects an expense on a unit the property does not have", () =>
            failsAndRollsBack({ expenses: [{ category: "repairs", amount: 10, on: "2026-10-01", unit: "999" }] }, "expense on unit 999"))
    })
})
