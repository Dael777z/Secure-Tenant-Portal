import bcrypt from "bcrypt"
import type { Pool, PoolClient } from "pg"

import { newInvite } from "../../utils/tokens"
import { DATASETS, PASSWORDS, type Dates, type SeedData, type SeedExpense, type SeedLease } from "./data"


/*
Seed() uses the datasets created in data.ts to commit sample data to the postgres database

Seed options specifies the webOrigin, the current date for relative dates, and the number of bcrypt hash rounds.
Seed options also specifies the dataset to be used from data.ts, either simple or clean for now.

Seed() uses the write() helper function to translate sample data into sql.

*/

// Options for the seed function
export interface SeedOptions {
    dataset?: keyof typeof DATASETS
    webOrigin: string
    bcryptRounds: number
    today?: Date // default to now()
}
 
export async function seed(pool: Pool, options: SeedOptions): Promise<string[]> {
    if ((await pool.query("SELECT 1 FROM Admin LIMIT 1")).rowCount) return ["already has data (an admin exists); nothing changed"]

    // setup the context object / tuple fields
    const today = options.today ?? new Date()
    const data = DATASETS[options.dataset ?? "sample"](datesFrom(today))
    const [staffHash, tenantHash] = await Promise.all([
        bcrypt.hash(PASSWORDS.staff, options.bcryptRounds),
        bcrypt.hash(PASSWORDS.tenant, options.bcryptRounds),
    ])

    // try and write the seed data to the pool, rollback if unsuccesful, always release.
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

// Helper function to write sample data with context into the pool while seeding.
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

    // Insert all sample staff data
    for (const s of data.staff) {
        await client.query("INSERT INTO Admin (name, email, password_hash, role) VALUES ($1, $2, $3, $4)", [s.name, s.email, ctx.staffHash, s.maintenance ? "maintenance_staff" : "admin"])
    }

    // Insert all sample property data
    for (const property of data.properties) {
        const { id: propertyId } = await one("INSERT INTO Property (Name, Address) VALUES ($1, $2) RETURNING pID AS id", [property.name, property.address])
        const unitIds = new Map<string, number>()

        // Insert all units belonging to this property into the one-to-many units table.
        for (const [unitNum, lease] of Object.entries(property.units)) {
            const { id: unitId } = await one("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS id", [propertyId, unitNum])
            unitIds.set(unitNum, unitId)
            units += 1
            if (!lease) continue

            // If unit has a lease attached

            const { id: leaseId } = await one(
                "INSERT INTO Lease (uID, start_date, end_date, monthly_rent) VALUES ($1, $2, $3, $4) RETURNING LeaseID AS id",
                [unitId, lease.since, lease.until ?? null, lease.rent.toFixed(2)],
            )
            leases += 1
            const payers: number[] = []

            // Insert all tenants belonging to this lease into the tenants table.
            for (const t of lease.tenants) {
                let tenantId = tenants.get(t.email)
                if (tenantId === undefined) {
                    if (t.invited) {
                        const { token, hash: invite } = newInvite()
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

            // Insert all payments belonging to this 
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

        //
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

        // Expenses for this property (005), optionally on one unit.
        for (const e of property.expenses ?? []) {
            const unitId = e.unit === undefined ? null : unitIds.get(e.unit)
            if (unitId === undefined) throw new Error(`seed data: expense on unit ${e.unit}, which ${property.name} does not have`)
            await writeExpense(client, { ...e, propertyId, unitId })
        }
    }

    for (const e of data.expenses ?? []) await writeExpense(client, { ...e, propertyId: null, unitId: null })

    // Generate the rent charges for every tenant beginning at date ending at today.
    await client.query("SELECT generate_rent_charges($1::date)", [isoDate(ctx.today)])

    return [
        `seeded: ${data.staff.length} staff, ${data.properties.length} properties, ${units} units, ${leases} leases, ${tenants.size} tenants`,
        `sign in: ${data.staff.map((s) => s.email).join(", ")} / ${PASSWORDS.staff}   tenants / ${PASSWORDS.tenant}`,
        ...(invites.length ? ["not signed up yet (sign-up links):", ...invites] : []),
    ]
}

// Generate sample payment history based off a lease and today's date, the sample data might include a partial payment on the last months.
function paymentHistory(lease: SeedLease, today: Date) {
    const dues = dueDates(lease, today) // find all due dates from the start of lease (lease.since) to today or lease end (lease.until)

    const unpaid = (lease.owes ?? 0) + (lease.partial ? 1 : 0) // calculate unpaid months and if a partial was included for last month using sample lease data

    const paid = dues.slice(0, Math.max(0, dues.length - unpaid)).map((due, month) => ({ due, month, amount: lease.rent })) // find only unpaid due dates
    // paid maps the unpaid slice of due dates into a month, due, amount paid format

    // if there is a partial payment and a dues list, push the partial payment onto the paid list
    if (lease.partial && dues.length) paid.push({ due: dues[dues.length - 1]!, month: dues.length - 1, amount: lease.partial })
    return paid
        .map((p) => {
            const at = new Date(`${p.due}T16:00:00Z`)
            // Most months on the due date or a day after; now and then a few days late.
            at.setUTCDate(at.getUTCDate() + [0, 1, 0, 2, 0, 4][p.month % 6]!)
            return { ...p, at, method: p.month % 4 === 3 ? "Check (recorded by office)" : "Bank transfer" }
        })
        .filter((p) => p.at <= today)
    // map paid into a series of payment histories  that include the paid tuple aswell as the date of the payment and a random payment method
}

// Calculate due dates for sample leases
function dueDates(lease: SeedLease, today: Date): string[] {
    const out = [lease.since] // date of the start of the lease

    const cursor = new Date(`${lease.since.slice(0, 8)}01T00:00:00Z`) // turn the lease start date into a Date object
    for (;;) {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1) // start of lease + 1 month = cursor

        const due = isoDate(cursor) // turn cursor Date into a due date string

        if (cursor > today || (lease.until && due > lease.until)) return out // check if due date has passed today or lease end date dont include, return due dates.

        out.push(due) // push new due date into the due dates array.
    }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

// implement dates from interface
function datesFrom(today: Date): Dates {
    return {
        monthsAgo(n, day = 1) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, day))
            return isoDate(d)
        },
        daysAhead(n) {
            // From the property's own calendar day (the finance screens count days left from it),
            // so a lease seeded 25 days out reads "25 days left" in the evening too.
            const [y, m, d] = today.toLocaleDateString("en-CA", { timeZone: "America/Denver" }).split("-").map(Number)
            return isoDate(new Date(Date.UTC(y!, m! - 1, d! + n)))
        },
        daysAgo(n, hour = 9) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n, hour))
            return d.toISOString()
        },
    }
}

async function writeExpense(client: PoolClient, e: SeedExpense & { propertyId: number | null; unitId: number | null }) {
    await client.query(
        "INSERT INTO Expenses (pID, uID, category, amount, spent_on, vendor, description) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [e.propertyId, e.unitId, e.category, e.amount.toFixed(2), e.on, e.vendor ?? null, e.description ?? null],
    )
}
