import bcrypt from "bcrypt"
import type { Pool } from "pg"
import { PostgresDatabase } from "../services/postgres-db"

export interface SeedOptions {
    adminEmail: string
    adminPassword: string
    bcryptRounds: number
}

/**
 * A small starting point: one manager who can sign in, one property with four
 * units, and one tenant the office has added (not signed up yet) on a lease.
 * Does nothing if an admin already exists.
 */
export async function seed(pool: Pool, options: SeedOptions): Promise<string> {
    const existing = await pool.query("SELECT 1 FROM Admin LIMIT 1")
    if (existing.rowCount) return "already seeded (an admin exists); nothing changed"

    const db = new PostgresDatabase(pool)
    await db.createUser({
        email: options.adminEmail.trim().toLowerCase(),
        password_h: await bcrypt.hash(options.adminPassword, options.bcryptRounds),
        role: "property_manager",
        name: "Demo Manager",
    })

    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        const property = await client.query<{ pid: number }>(
            "INSERT INTO Property (Name, Address) VALUES ('Woodcrest Apartments', '2400 Woodcrest Dr, Las Cruces, NM 88011') RETURNING pID AS pid",
        )
        const pid = property.rows[0]!.pid
        const units = await client.query<{ uid: number; unitnum: string }>(
            `INSERT INTO Units (pID, UnitNum) SELECT $1, n FROM unnest(ARRAY['101','102','103','104']) AS n
             RETURNING uID AS uid, UnitNum AS unitnum`,
            [pid],
        )
        const unit101 = units.rows.find((u) => u.unitnum === "101")!.uid
        const tenant = await client.query<{ tid: number }>(
            "INSERT INTO Tenants (Name, Phone, Email) VALUES ('Test Tenant', '(575) 555-0101', 'tenant@example.com') RETURNING tID AS tid",
        )
        const lease = await client.query<{ leaseid: number }>(
            "INSERT INTO Lease (uID, start_date, end_date, ammount_owed) VALUES ($1, '2026-09-01', '2027-08-31', 950.00) RETURNING LeaseID AS leaseid",
            [unit101],
        )
        await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [lease.rows[0]!.leaseid, tenant.rows[0]!.tid])
        await client.query("INSERT INTO Payment (LeaseID, ammount) VALUES ($1, 950.00)", [lease.rows[0]!.leaseid])
        await client.query("INSERT INTO Maintenance_T (uID, tID) VALUES ($1, $2)", [unit101, tenant.rows[0]!.tid])
        await client.query("COMMIT")
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }
    return `seeded: manager ${options.adminEmail}; tenant@example.com is invited (sign up at /api/auth/signup)`
}
