import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createStaffAccount } from "../db/admin"
import { checkDatabase, migrate, migrationStatus, MIGRATIONS_DIR, wipe } from "../db/migrate"
import { seed } from "../db/seed"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

/** What `npm run db ...` and the server's startup check do, against a real database. */
describe.skipIf(!hasDatabase)("database setup: migrate, seed, reset, startup check", () => {
    let t: TestDatabase
    beforeAll(async () => { t = await freshDatabase("portal_setup_test") })
    afterAll(async () => { await t?.drop() })

    it("is fully migrated, and the app's login passes the startup check", async () => {
        const status = await migrationStatus(t.owner)
        expect(status.pending).toEqual([])
        expect(status.applied.map((file) => file.name)).toEqual(["001_schema.sql", "002_portal.sql", "003_maintenance_staff.sql", "004_messages.sql", "005_finance.sql", "006_tenant_settings.sql"])
        await expect(checkDatabase(t.app)).resolves.toBeUndefined()
        expect(await migrate(t.owner)).toEqual([])   // nothing left to do
    })

    it("the startup check says what to run when a migration is missing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "migrations-"))
        try {
            cpSync(MIGRATIONS_DIR, dir, { recursive: true })
            writeFileSync(join(dir, "003_next.sql"), "SELECT 1;")
            await expect(checkDatabase(t.app, dir)).rejects.toThrow("missing migrations: 003_next.sql. Run: npm run db migrate")
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("refuses to run when an applied migration was edited", async () => {
        const dir = mkdtempSync(join(tmpdir(), "migrations-"))
        try {
            cpSync(MIGRATIONS_DIR, dir, { recursive: true })
            writeFileSync(join(dir, "002_portal.sql"), "-- edited\n", { flag: "a" })
            await expect(migrate(t.owner, dir)).rejects.toThrow("002_portal.sql was edited")
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("loads the full sample once, with history, balances and an invite link", async () => {
        const report = await seed(t.owner, { webOrigin: "http://localhost:5173", bcryptRounds: 4 })
        expect(report[0]).toBe("seeded: 2 staff, 2 properties, 18 units, 14 leases, 15 tenants")
        expect(report.join("\n")).toMatch(/nora\.brooks@example\.com: http:\/\/localhost:5173\/signup\?token=[0-9a-f]{64}/)

        const count = async (sql: string) => (await t.owner.query(sql)).rows[0].n as number
        expect(await count("SELECT count(*)::int AS n FROM Maintenance_T")).toBe(6)
        // Owing leases: 101, 102, 104 (partial), 107, 111, A2.
        expect(await count("SELECT count(*)::int AS n FROM lease_balance WHERE balance > 0")).toBe(6)
        expect(await count("SELECT count(*)::int AS n FROM lease_balance WHERE balance < 0")).toBe(0)

        expect(await seed(t.owner, { webOrigin: "x", bcryptRounds: 4 })).toEqual(["already has data (an admin exists); nothing changed"])
    })

    it("reset: wipe, migrate and seed again from nothing", async () => {
        await wipe(t.owner)
        await expect(checkDatabase(t.app)).rejects.toThrow("no tables yet")
        expect(await migrate(t.owner)).toEqual(["001_schema.sql", "002_portal.sql", "003_maintenance_staff.sql", "004_messages.sql", "005_finance.sql", "006_tenant_settings.sql"])
        expect((await seed(t.owner, { dataset: "clean", webOrigin: "x", bcryptRounds: 4 }))[0]).toBe("seeded: 2 staff, 1 properties, 4 units, 1 leases, 1 tenants")
        await expect(checkDatabase(t.app)).resolves.toBeUndefined()
    })

    it("adds a staff login to an empty database, once per email", async () => {
        await wipe(t.owner)
        await migrate(t.owner)
        await createStaffAccount(t.owner, { email: "Office@Example.com", name: "Office", password: "office-pass-1", bcryptRounds: 4 })
        expect(await t.db.findUserByEmail("office@example.com")).toMatchObject({ role: "admin" })
        await expect(createStaffAccount(t.owner, { email: "office@example.com", name: "Again", password: "office-pass-1", bcryptRounds: 4 })).rejects.toThrow("already has an account")
        await expect(createStaffAccount(t.owner, { email: "x@example.com", name: "Short", password: "short", bcryptRounds: 4 })).rejects.toThrow("at least 8")
    })

    it("refuses to run the app as anyone but summit_app (the owner would skip row-level security)", async () => {
        await expect(checkDatabase(t.owner)).rejects.toThrow("must use summit_app")
    })

    it("a wrong app password gets a message that says what to do", async () => {
        const url = new URL(t.appUrl)
        url.password = "wrong"
        const bad = new Pool({ connectionString: url.toString(), max: 1 })
        try {
            await expect(checkDatabase(bad)).rejects.toThrow("summit_app could not sign in")
        } finally {
            await bad.end()
        }
    })
})
