import bcrypt from "bcrypt"
import type { Pool, PoolClient } from "pg"
import { PostgresDatabase } from "../services/postgres-db"

export interface SeedOptions {
    adminEmail: string
    adminPassword: string
    bcryptRounds: number
    /** For demos: sign tenant@example.com up with this password. */
    tenantPassword?: string
    /** "Today" for the sample history. Defaults to now. */
    today?: Date
}

/**
 * Sample data for demos, on Angel's tables:
 *
 *   - one property manager (SEED_ADMIN_EMAIL) and one on-site maintenance login
 *   - Woodcrest Apartments (units 101–112) and Mesilla Court (A1–A6)
 *   - 14 leases with rent history since each move-in: most paid on time, a few
 *     owing, one partial payment, one lease shared by two cosigners
 *   - maintenance requests in every status
 *   - tenant@example.com on unit 101; one tenant who has not signed up yet
 *   - every signed-up sample resident uses the same demo password
 *
 * Does nothing if an admin already exists.
 */

interface SampleLease {
    unit: string
    rent: number
    start: string
    tenants: Array<[name: string, email: string, phone: string | null]>
    /** How the months were paid: "paid" each month, or the months left unpaid / part-paid. */
    unpaidMonths?: number
    partial?: number
}

const WOODCREST: SampleLease[] = [
    { unit: "101", rent: 950, start: "2026-09-01", tenants: [["Test Tenant", "tenant@example.com", "(575) 555-0101"]], unpaidMonths: 1 },
    { unit: "102", rent: 910, start: "2026-03-01", tenants: [["James Johnson", "james.johnson@example.com", "(575) 555-0102"]], unpaidMonths: 2 },
    { unit: "103", rent: 975, start: "2026-01-01", tenants: [["Aisha Okafor", "aisha.okafor@example.com", "(575) 555-0103"]] },
    { unit: "104", rent: 1020, start: "2026-05-15", tenants: [["Diego Fitzgerald", "diego.f@example.com", null]], partial: 520 },
    {
        unit: "105", rent: 1180, start: "2026-02-01",
        tenants: [["Sarah Alvarez", "sarah.alvarez@example.com", "(575) 555-0105"], ["Marco Alvarez", "marco.alvarez@example.com", "(575) 555-0115"]],
    },
    { unit: "106", rent: 950, start: "2026-06-01", tenants: [["Priya Sharma", "priya.sharma@example.com", "(575) 555-0106"]] },
    { unit: "107", rent: 990, start: "2026-08-01", tenants: [["Raj Johnson", "raj.johnson@example.com", null]], unpaidMonths: 1 },
    { unit: "109", rent: 1050, start: "2025-11-01", tenants: [["Elena Alvarez", "elena.alvarez@example.com", "(575) 555-0109"]] },
    { unit: "110", rent: 1210, start: "2026-04-01", tenants: [["Chen Wei", "chen.wei@example.com", "(575) 555-0110"]] },
    { unit: "111", rent: 930, start: "2026-10-01", tenants: [["Nora Brooks", "nora.brooks@example.com", null]], unpaidMonths: 1 },
]
const MESILLA: SampleLease[] = [
    { unit: "A1", rent: 1350, start: "2026-02-01", tenants: [["Tom Nguyen", "tom.nguyen@example.com", "(575) 555-0201"]] },
    { unit: "A2", rent: 1290, start: "2026-07-01", tenants: [["Lucia Reyes", "lucia.reyes@example.com", "(575) 555-0202"]], unpaidMonths: 1 },
    { unit: "A4", rent: 1400, start: "2026-03-01", tenants: [["Ben Osei", "ben.osei@example.com", "(575) 555-0204"]] },
    { unit: "A5", rent: 1325, start: "2026-09-01", tenants: [["Hana Tanaka", "hana.tanaka@example.com", null]] },
]
/** Added by the office, on a lease, but has not signed up yet. */
const NOT_SIGNED_UP = "nora.brooks@example.com"

function monthStarts(start: string, today: Date): string[] {
    const first = new Date(`${start}T00:00:00Z`)
    const out: string[] = []
    const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1))
    while (cursor <= today) {
        out.push(out.length === 0 ? start : cursor.toISOString().slice(0, 10))
        cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    return out
}

async function addProperty(client: PoolClient, name: string, address: string, units: string[]): Promise<Map<string, number>> {
    const { rows } = await client.query<{ pid: number }>("INSERT INTO Property (Name, Address) VALUES ($1, $2) RETURNING pID AS pid", [name, address])
    const ids = new Map<string, number>()
    for (const unit of units) {
        const u = await client.query<{ uid: number }>("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS uid", [rows[0]!.pid, unit])
        ids.set(unit, u.rows[0]!.uid)
    }
    return ids
}

export async function seed(pool: Pool, options: SeedOptions): Promise<string> {
    const existing = await pool.query("SELECT 1 FROM Admin LIMIT 1")
    if (existing.rowCount) return "already seeded (an admin exists); nothing changed"

    const today = options.today ?? new Date()
    const db = new PostgresDatabase(pool)
    const staffHash = await bcrypt.hash(options.adminPassword, options.bcryptRounds)
    await db.createUser({ email: options.adminEmail.trim().toLowerCase(), password_h: staffHash, role: "property_manager", name: "Dana Whitfield" })
    await db.createUser({ email: "maintenance@example.com", password_h: staffHash, role: "maintenance_staff", name: "Ray Ortiz" })

    const tenantHash = options.tenantPassword ? await bcrypt.hash(options.tenantPassword, options.bcryptRounds) : null
    // Every signed-up sample resident shares one password: the tenant demo
    // password when set, otherwise the manager's.
    const residentHash = tenantHash ?? staffHash
    let confirmation = 10_000_000

    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        const woodcrest = await addProperty(client, "Woodcrest Apartments", "2400 Woodcrest Dr, Las Cruces, NM 88011",
            ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112"])
        const mesilla = await addProperty(client, "Mesilla Court", "118 Calle de Guadalupe, Mesilla, NM 88046", ["A1", "A2", "A3", "A4", "A5", "A6"])

        for (const [units, leases] of [[woodcrest, WOODCREST], [mesilla, MESILLA]] as const) {
            for (const lease of leases) {
                const uid = units.get(lease.unit)!
                const l = await client.query<{ leaseid: number }>(
                    "INSERT INTO Lease (uID, start_date, end_date, ammount_owed) VALUES ($1, $2, $3, $4) RETURNING LeaseID AS leaseid",
                    [uid, lease.start, null, lease.rent.toFixed(2)],
                )
                const leaseId = l.rows[0]!.leaseid
                const tenantIds: number[] = []
                for (const [name, email, phone] of lease.tenants) {
                    const signedUp = email !== NOT_SIGNED_UP && (email !== "tenant@example.com" || tenantHash !== null)
                    const t = await client.query<{ tid: number }>(
                        "INSERT INTO Tenants (Name, Phone, Email, password_hash, signed_up) VALUES ($1, $2, $3, $4, $5) RETURNING tID AS tid",
                        [name, phone, email, signedUp ? residentHash : null, signedUp],
                    )
                    tenantIds.push(t.rows[0]!.tid)
                    await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [leaseId, t.rows[0]!.tid])
                }

                // Rent history: each month paid on the 3rd, except the unpaid
                // ones at the end; a partial payment covers part of the last month.
                const months = monthStarts(lease.start, today)
                const paidMonths = months.slice(0, Math.max(0, months.length - (lease.unpaidMonths ?? 0) - (lease.partial ? 1 : 0)))
                for (const [i, month] of paidMonths.entries()) {
                    const paidAt = new Date(`${month.slice(0, 8)}03T16:00:00Z`)
                    if (paidAt > today) continue
                    confirmation += 1
                    await client.query(
                        "INSERT INTO Payment (LeaseID, ammount, tID, method, confirmation, timestamp) VALUES ($1, $2, $3, $4, $5, $6)",
                        [leaseId, lease.rent.toFixed(2), tenantIds[i % tenantIds.length], i % 4 === 3 ? "Check (recorded by office)" : "Bank transfer (demo)", `CONF-${confirmation}`, paidAt],
                    )
                }
                if (lease.partial) {
                    const month = months[months.length - 1]!
                    confirmation += 1
                    await client.query(
                        "INSERT INTO Payment (LeaseID, ammount, tID, method, confirmation, timestamp) VALUES ($1, $2, $3, 'Bank transfer (demo)', $4, $5)",
                        [leaseId, lease.partial.toFixed(2), tenantIds[0], `CONF-${confirmation}`, new Date(`${month.slice(0, 8)}04T16:00:00Z`)],
                    )
                }
            }
        }

        const tenantOf = async (email: string) =>
            (await client.query<{ tid: number }>("SELECT tID AS tid FROM Tenants WHERE Email = $1", [email])).rows[0]!.tid
        const requests: Array<[string, string, string, string, string, string]> = [
            ["101", "tenant@example.com", "Kitchen faucet leaking", "Steady drip under the sink, worse in the morning.", "in_progress", "2026-09-29 09:00"],
            ["101", "tenant@example.com", "Dishwasher clogged", "Water pools at the bottom after a full cycle.", "resolved", "2026-08-15 09:00"],
            ["106", "priya.sharma@example.com", "No heat, apartment is 52 degrees", "The heater turns on but blows cold air.", "submitted", "2026-10-04 07:30"],
            ["103", "aisha.okafor@example.com", "Front door deadbolt sticking", "Hard to lock from outside.", "resolved", "2026-10-01 15:00"],
            ["110", "chen.wei@example.com", "Bathroom fan is loud", "Rattles when it is on.", "submitted", "2026-10-06 18:00"],
        ]
        for (const [unit, email, title, description, status, at] of requests) {
            await client.query(
                "INSERT INTO Maintenance_T (uID, tID, title, description, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                [woodcrest.get(unit)!, await tenantOf(email), title, description, status, at],
            )
        }
        await client.query(
            "INSERT INTO Maintenance_T (uID, title, description, status, created_at) VALUES ($1, 'Water heater leaking into hallway', 'Reported by the office after inspection.', 'in_progress', '2026-10-05 10:00')",
            [mesilla.get("A3")!],
        )
        await client.query("COMMIT")
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }

    const tenantLine = tenantHash
        ? "tenant@example.com is signed up (demo password set)"
        : "tenant@example.com is invited (sign up at /api/auth/signup)"
    return `seeded: manager ${options.adminEmail} and maintenance@example.com (same password); 2 properties, 18 units, 14 leases; ${tenantLine}`
}
