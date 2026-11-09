import bcrypt from "bcrypt"
import { createHash } from "node:crypto"
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
    /**
     * 008: a late fee rule and a rent reminder rule for all properties (dated 45
     * days back, so their fees and reminders show), and a signed lease PDF for
     * the sample tenant. The CLI and the demo turn this on; tests leave it off.
     */
    rules?: boolean
    /** For the late fee and reminder jobs (default America/Denver). */
    timeZone?: string
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
        if (options.rules) report.push(...(await writeRules(client, today, options.timeZone ?? "America/Denver")))
        if (options.rules) report.push(...(await writeAdditions(client, today)))
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

            // A Cash App / Zelle payment the tenant reported, waiting for the office (006).
            if (lease.reported) {
                const owed = Math.round(((lease.owes ?? 0) * lease.rent + (lease.partial ? lease.rent - lease.partial : 0)) * 100) / 100
                if (owed <= 0) throw new Error(`seed data: ${property.name} lease reports a payment but owes nothing`)
                const at = new Date(ctx.today.getTime() - lease.reported.daysAgo * 86_400_000)
                confirmation += 1
                const { id: payId } = await one(
                    `INSERT INTO Payment (LeaseID, direction, amount, status, transaction_id, "timestamp")
                     VALUES ($1, 'charge', $2, 'pending', $3, $4) RETURNING payID AS id`,
                    [leaseId, owed.toFixed(2), `CONF-${confirmation}`, at],
                )
                const label = lease.reported.method === "zelle" ? "Zelle" : "Cash App"
                await client.query("INSERT INTO Payment_Details (payID, tID, method) VALUES ($1, $2, $3)", [payId, payers[0], `${label} (reported by tenant)`])
                await client.query("INSERT INTO Reported_Payments (payID, method, reported_by, reported_at) VALUES ($1, $2, $3, $4)", [payId, lease.reported.method, payers[0], at])
            }
        }

        //
        for (const r of property.maintenance ?? []) {
            const unitId = unitIds.get(r.unit)
            if (unitId === undefined) throw new Error(`seed data: maintenance for unit ${r.unit}, which ${property.name} does not have`)
            const tenantId = r.by === undefined ? null : tenants.get(r.by)
            if (tenantId === undefined) throw new Error(`seed data: maintenance filed by ${r.by}, who is not a tenant`)
            await client.query(
                `INSERT INTO Maintenance_T (uID, tID, title, description, status, created_at, priority, request_type, scheduled_for)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [unitId, tenantId, r.title, r.description ?? "", r.status, r.filed, r.priority ?? "none", r.requestType ?? "other",
                 r.scheduledIn === undefined ? null : isoDate(new Date(ctx.today.getTime() + r.scheduledIn * 86_400_000))],
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

    if (data.office) {
        await client.query("UPDATE Office_Settings SET cashapp_handle = $1, zelle_handle = $2 WHERE id", [data.office.cashapp, data.office.zelle])
    }

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
            // Never dated after today: early in a month the delay would be, and the payment would be lost.
            return { ...p, at: at > today ? today : at, method: p.month % 4 === 3 ? "Check (recorded by office)" : "Bank transfer" }
        })
    // map paid into a series of payment histories  that include the paid tuple aswell as the date of the payment and a random payment method
}

// Rent due dates for a sample lease: the lease's start day each month (007), or
// the month's last day when it is shorter, up to today or the lease end.
function dueDates(lease: SeedLease, today: Date): string[] {
    const [y, m, d] = lease.since.split("-").map(Number) as [number, number, number]
    const out: string[] = []
    for (let n = 0; ; n++) {
        const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate()
        const due = isoDate(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))))
        if (new Date(`${due}T00:00:00Z`) > today || (lease.until && due > lease.until)) return out
        out.push(due)
    }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** 008's sample rules, run once so their late fees and reminders are on the ledgers. */
async function writeRules(client: PoolClient, today: Date, timeZone: string): Promise<string[]> {
    const since = new Date(today.getTime() - 45 * 86_400_000)
    await client.query(
        `INSERT INTO Late_Fee_Rules (grace_days, first_amount, first_type, daily_amount, daily_type, max_amount, max_type, created_at)
         VALUES (5, 50, 'flat', 10, 'flat', 100, 'flat', $1)`,
        [since],
    )
    await client.query("INSERT INTO Rent_Reminder_Rules (days_before, repeat_after_due, created_at) VALUES (3, true, $1)", [since])
    const day = today.toLocaleDateString("en-CA", { timeZone })
    const fees = (await client.query<{ n: number }>("SELECT apply_late_fees($1::date, $2) AS n", [day, timeZone])).rows[0]!.n
    const reminders = (await client.query<{ n: number }>("SELECT send_rent_reminders($1::date, $2) AS n", [day, timeZone])).rows[0]!.n

    // The sample tenant's signed lease.
    const lease = await client.query<{ id: number }>(
        `SELECT lt.LeaseID AS id FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID JOIN Lease l ON l.LeaseID = lt.LeaseID
          WHERE t.Email = 'tenant@example.com' ORDER BY l.start_date DESC LIMIT 1`,
    )
    let docs = 0
    if (lease.rows[0]) {
        const pdf = samplePdf("Residential Lease Agreement (sample)")
        await client.query(
            `INSERT INTO Lease_Documents (LeaseID, filename, content_type, size_bytes, sha256_hex, data) VALUES ($1, $2, 'application/pdf', $3, $4, $5)`,
            [lease.rows[0].id, "Signed lease - Unit 101.pdf", pdf.length, createHash("sha256").update(pdf).digest("hex"), pdf],
        )
        docs = 1
    }
    return [`rules: late fees (5-day grace, $50 then $10 a day, at most $100) and reminders (3 days before, daily while late): ${fees} fees, ${reminders} reminders, ${docs} lease PDF`]
}

/**
 * 009's sample: a portfolio with the Woodcrest building in it, city/state/ZIP for
 * both buildings, unit 108 listed with two people asking about it, a notice the
 * office sent, renters insurance on file for the sample tenant, and the faucet
 * request assigned to the maintenance teammate with a note.
 */
async function writeAdditions(client: PoolClient, today: Date): Promise<string[]> {
    const ago = (days: number) => new Date(today.getTime() - days * 86_400_000)
    const manager = (await client.query<{ id: number }>("SELECT admin_id AS id FROM Admin WHERE role = 'admin' ORDER BY admin_id LIMIT 1")).rows[0]?.id ?? null
    const fixer = (await client.query<{ id: number }>("SELECT admin_id AS id FROM Admin WHERE role = 'maintenance_staff' ORDER BY admin_id LIMIT 1")).rows[0]?.id ?? null
    const portfolio = await client.query<{ id: number }>(
        "INSERT INTO Portfolios (name, entity_name, created_by) VALUES ('Woodcrest Holdings', 'Woodcrest Holdings LLC (sample)', $1) RETURNING portfolio_id AS id",
        [manager],
    )
    await client.query("UPDATE Property SET portfolio_id = $1, city = 'Las Cruces', state = 'NM', zip = '88011' WHERE Name = 'Woodcrest Apartments'", [portfolio.rows[0]!.id])
    await client.query("UPDATE Property SET city = 'Mesilla', state = 'NM', zip = '88046' WHERE Name = 'Mesilla Court'")

    const unit = await client.query<{ id: number }>(
        "SELECT u.uID AS id FROM Units u JOIN Property p ON p.pID = u.pID WHERE p.Name = 'Woodcrest Apartments' AND u.UnitNum = '108'",
    )
    let listings = 0
    if (unit.rows[0]) {
        const available = new Date(today.getTime() + 9 * 86_400_000).toISOString().slice(0, 10)
        const listing = await client.query<{ id: number }>(
            `INSERT INTO Listings (uID, status, title, description, asking_rent, available_on, beds, baths, sqft, amenities, pets, created_by, created_at, published_at)
             VALUES ($1, 'active', 'Bright 1-bedroom with balcony',
                     'Second-floor corner unit with a private balcony, new kitchen floors and a large closet. Laundry room on every floor.',
                     975, $2, 1, 1, 640, ARRAY['Balcony', 'Laundry in building', 'Off-street parking'], 'Cats OK', $3, $4, $5) RETURNING listingID AS id`,
            [unit.rows[0].id, available, manager, ago(6), ago(5)],
        )
        await client.query(
            `INSERT INTO Leads (listingID, name, email, phone, message, source, status, created_at) VALUES
                 ($1, 'Jordan Park', 'jordan.park@example.com', NULL, 'Is parking included in the rent?', 'website', 'new', $2),
                 ($1, 'Maria Lopez', NULL, '(575) 555-0177', 'Called the office; wants to see it on Saturday.', 'manual', 'contacted', $3)`,
            [listing.rows[0]!.id, ago(1), ago(3)],
        )
        listings = 1
    }

    const notice = await client.query(
        `INSERT INTO Notifications_Sent (tID, LeaseID, template, subject, body, created_by, created_at, sent_at)
         SELECT DISTINCT ON (lt.tID) lt.tID, l.LeaseID, 'manual', 'Parking lot repaving Thursday',
                'The north lot will be repaved on Thursday from 8am to 4pm. Please park on Woodcrest Drive that day. Cars left in the lot may be moved.',
                $1, $2, $2
         FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
         WHERE p.Name = 'Woodcrest Apartments' AND l.start_date <= $3::date AND (l.end_date IS NULL OR l.end_date >= $3::date)
         ORDER BY lt.tID, l.start_date DESC`,
        [manager, ago(2), today.toISOString().slice(0, 10)],
    )
    await client.query(
        `INSERT INTO Tenant_Details (tID, insurance_status, insurance_expires, emergency_contact_name, emergency_contact_phone, updated_by)
         SELECT tID, 'on_file', $1::date, 'Sam Tenant', '(575) 555-0190', $2 FROM Tenants WHERE Email = 'tenant@example.com'`,
        [new Date(today.getTime() + 200 * 86_400_000).toISOString().slice(0, 10), manager],
    )
    const faucet = await client.query<{ id: number }>("SELECT mID AS id FROM Maintenance_T WHERE title = 'Kitchen faucet leaking' LIMIT 1")
    if (faucet.rows[0] && fixer !== null) {
        await client.query("UPDATE Maintenance_T SET assigned_to = $2, labor_cost = 85 WHERE mID = $1", [faucet.rows[0].id, fixer])
        await client.query("INSERT INTO Maintenance_Notes (mID, admin_id, body, created_at) VALUES ($1, $2, 'Cartridge ordered; back Thursday to replace it.', $3)", [faucet.rows[0].id, fixer, ago(2)])
    }
    return [`009 sample: 1 portfolio, ${listings} listing with 2 leads, a notice to ${notice.rowCount} Woodcrest residents, renters insurance for the sample tenant, the faucet request assigned`]
}

/** A one-page PDF with a title line (valid enough for any viewer). */
export function samplePdf(title: string): Buffer {
    const text = title.replace(/[()\\]/g, "")
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        "",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\nBT /F1 11 Tf 72 690 Td (Sample document for the demo. Not a real lease.) Tj ET`
    objects[3] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    let body = "%PDF-1.4\n"
    const offsets: number[] = []
    objects.forEach((o, i) => {
        offsets.push(Buffer.byteLength(body))
        body += `${i + 1} 0 obj\n${o}\nendobj\n`
    })
    const xref = Buffer.byteLength(body)
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(body, "latin1")
}

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
