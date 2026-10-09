// The clean start for a live demo: staff, one example tenant, nothing else.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Pool } from "pg"
import { seed } from "../db/seed"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_seed_clean"

describe.skipIf(!hasDatabase)("clean demo seed", () => {
    let pool: Pool

    beforeAll(async () => {
        pool = await freshSchema(SCHEMA)
    })
    afterAll(async () => {
        if (pool) await dropSchema(pool, SCHEMA)
    })

    it("has two staff logins, one property with four units, and one tenant on unit 101", async () => {
        const message = await seed(pool, {
            adminEmail: "manager@example.com", adminPassword: "manager password", tenantPassword: "tenant password",
            bcryptRounds: 4, sampleData: false, today: new Date("2026-10-08T18:00:00Z"),
        })
        expect(message).toContain("clean start")
        const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count)
        expect(await count("Admin")).toBe(2)
        expect(await count("Property")).toBe(1)
        expect(await count("Units")).toBe(4)
        expect(await count("Lease")).toBe(1)
        expect(await count("Tenants")).toBe(1)
        expect(await count("Payment")).toBe(0)
        expect(await count("Maintenance_T")).toBe(0)
        const lease = (await pool.query("SELECT start_date::text AS start, ammount_owed::text AS rent FROM Lease")).rows[0]
        expect(lease).toEqual({ start: "2026-10-01", rent: "950.00" })
        const tenant = (await pool.query("SELECT signed_up FROM Tenants WHERE Email = 'tenant@example.com'")).rows[0]
        expect(tenant.signed_up).toBe(true)
    })
})
