import bcrypt from "bcrypt"
import type { Pool, PoolClient } from "pg"

import { newInvite } from "../../utils/tokens"
import { DATASETS, PASSWORDS, type Dates, type SeedData, type SeedLease } from "./data"

/**
 * Writes a dataset from ./data.ts, in one transaction, as the schema owner
 * (before any staff exist there is nobody for the app's login to act as).
 * Does nothing if the database already has staff.
 */
export interface SeedOptions {
    dataset?: keyof typeof DATASETS
    /** Where invite links point. */
    webOrigin: string
    bcryptRounds: number
    /** "Today" for the relative dates. Defaults to now. */
    today?: Date
}

export async function seed(pool: Pool, options: SeedOptions): Promise<string[]> {
    if ((await pool.query("SELECT 1 FROM Admin LIMIT 1")).rowCount) return ["already has data (an admin exists); nothing changed"]

    const today = options.today ?? new Date()
    const data = DATASETS[options.dataset ?? "sample"](datesFrom(today))
    const [staffHash, tenantHash] = await Promise.all([
        bcrypt.hash(PASSWORDS.staff, options.bcryptRounds),
        bcrypt.hash(PASSWORDS.tenant, options.bcryptRounds),
    ])

    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        // generate_rent_charges only bills for an admin or 'system'.
        await client.query("SELECT set_config('app.user_type', 'system', true)")
        const report = await write(client, data, { staffHash, tenantHash, today, webOrigin: options.webOrigin })
        await client.query("COMMIT")
        return report
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }
}

async function write(
    client: PoolClient, data: SeedData,
    ctx: { staffHash: string; tenantHash: string; today: Date; webOrigin: string },
): Promise<string[]> {
    const one = async <T = { id: number }>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows[0] as T
    const tenants = new Map<string, number>()
    const invites: string[] = []
    let confirmation = 10_000_000
    let leases = 0
    let units = 0

    for (const s of data.staff) {
        await client.query("INSERT INTO Admin (name, email, password_hash, role) VALUES ($1, $2, $3, $4)", [s.name, s.email, ctx.staffHash, s.maintenance ? "maintenance_staff" : "admin"])
    }

    for (const property of data.properties) {
        const { id: propertyId } = await one("INSERT INTO Property (Name, Address) VALUES ($1, $2) RETURNING pID AS id", [property.name, property.address])
        const unitIds = new Map<string, number>()

        for (const [unitNum, lease] of Object.entries(property.units)) {
            const { id: unitId } = await one("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS id", [propertyId, unitNum])
            unitIds.set(unitNum, unitId)
            units += 1
            if (!lease) continue

            const { id: leaseId } = await one(
                "INSERT INTO Lease (uID, start_date, end_date, monthly_rent) VALUES ($1, $2, $3, $4) RETURNING LeaseID AS id",
                [unitId, lease.since, lease.until ?? null, lease.rent.toFixed(2)],
            )
            leases += 1
            const payers: number[] = []
            for (const t of lease.tenants) {
                let tenantId = tenants.get(t.email)
                if (tenantId === undefined) {
                    if (t.invited) {
                        const { token, invite } = newInvite()
                        tenantId = (await one(
                            "INSERT INTO Tenants (Name, Phone, Email, signup_token_hash, signup_token_expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING tID AS id",
                            [t.name, t.phone ?? null, t.email, invite.tokenHash, invite.expiresAt],
                        )).id
                        invites.push(`  ${t.email}: ${ctx.webOrigin.replace(/\/$/, "")}/signup?token=${token}`)
                    } else {
                        tenantId = (await one(
                            "INSERT INTO Tenants (Name, Phone, Email, password_hash, signup_completed) VALUES ($1, $2, $3, $4, true) RETURNING tID AS id",
                            [t.name, t.phone ?? null, t.email, ctx.tenantHash],
                        )).id
                    }
                    tenants.set(t.email, tenantId)
                }
                payers.push(tenantId)
                await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [leaseId, tenantId])
            }

            for (const p of paymentHistory(lease, ctx.today)) {
                confirmation += 1
                const payer = payers[p.month % payers.length]!
                const { id: payId } = await one(
                    `INSERT INTO Payment (LeaseID, direction, amount, status, transaction_id, "timestamp")
                     VALUES ($1, 'charge', $2, 'completed', $3, $4) RETURNING payID AS id`,
                    [leaseId, p.amount.toFixed(2), `CONF-${confirmation}`, p.at],
                )
                await client.query("INSERT INTO Payment_Details (payID, tID, method) VALUES ($1, $2, $3)", [payId, payer, p.method])
            }
        }

        for (const r of property.maintenance ?? []) {
            const unitId = unitIds.get(r.unit)
            if (unitId === undefined) throw new Error(`seed data: maintenance for unit ${r.unit}, which ${property.name} does not have`)
            const tenantId = r.by === undefined ? null : tenants.get(r.by)
            if (tenantId === undefined) throw new Error(`seed data: maintenance filed by ${r.by}, who is not a tenant`)
            await client.query(
                "INSERT INTO Maintenance_T (uID, tID, title, description, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                [unitId, tenantId, r.title, r.description ?? "", r.status, r.filed],
            )
        }
    }

    // Every rent charge up to today, by the same function the app uses.
    await client.query("SELECT generate_rent_charges($1::date)", [isoDate(ctx.today)])

    return [
        `seeded: ${data.staff.length} staff, ${data.properties.length} properties, ${units} units, ${leases} leases, ${tenants.size} tenants`,
        `sign in: ${data.staff.map((s) => s.email).join(", ")} / ${PASSWORDS.staff}   tenants / ${PASSWORDS.tenant}`,
        ...(invites.length ? ["not signed up yet (sign-up links):", ...invites] : []),
    ]
}

/** One payment per month due, paid two days after the due date, except the last `owes` months; `partial` pays part of the last. */
function paymentHistory(lease: SeedLease, today: Date) {
    const dues = dueDates(lease, today)
    const unpaid = (lease.owes ?? 0) + (lease.partial ? 1 : 0)
    const paid = dues.slice(0, Math.max(0, dues.length - unpaid)).map((due, month) => ({ due, month, amount: lease.rent }))
    if (lease.partial && dues.length) paid.push({ due: dues[dues.length - 1]!, month: dues.length - 1, amount: lease.partial })
    return paid
        .map((p) => {
            const at = new Date(`${p.due}T16:00:00Z`)
            at.setUTCDate(at.getUTCDate() + 2)
            return { ...p, at, method: p.month % 4 === 3 ? "Check (recorded by office)" : "Bank transfer" }
        })
        .filter((p) => p.at <= today)
}

/** Same rule as generate_rent_charges: the start date, then the 1st of each month, up to today and the end date. */
function dueDates(lease: SeedLease, today: Date): string[] {
    const out = [lease.since]
    const cursor = new Date(`${lease.since.slice(0, 8)}01T00:00:00Z`)
    for (;;) {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1)
        const due = isoDate(cursor)
        if (cursor > today || (lease.until && due > lease.until)) return out
        out.push(due)
    }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

function datesFrom(today: Date): Dates {
    return {
        monthsAgo(n, day = 1) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, day))
            return isoDate(d)
        },
        daysAgo(n, hour = 9) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n, hour))
            return d.toISOString()
        },
    }
}
