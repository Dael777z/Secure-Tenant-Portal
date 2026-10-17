/**
 * The sample data. Edit this file to change what `npm run db seed` loads,
 * then `npm run db reset` to reload it. (src/db/seed/index.ts writes it to
 * the database; you should not need to touch that file to add data.)
 *
 * Dates are relative to the day you seed (`monthsAgo`, `daysAgo`), so the
 * data always has a current month, recent requests and a believable history.
 *
 * Each lease gets every month's rent charge since it started, and a payment
 * for each month except the last `owes` months. `partial` pays part of the
 * last month instead. Tenants marked `invited` have not signed up: the seed
 * prints their sign-up link.
 */

/** Every seeded login uses one of these. Development data only. */
export const PASSWORDS = {
    staff: "manager-demo-password",
    tenant: "tenant-demo-password",
}

export interface SeedTenant {
    name: string
    email: string
    phone?: string
    /** On the lease but not signed up yet. */
    invited?: boolean
}

export interface SeedLease {
    rent: number
    /** Move-in date, YYYY-MM-DD. The first month is due on this date, later months on the 1st. */
    since: string
    /** Optional move-out date. */
    until?: string
    tenants: SeedTenant[]
    /** Months at the end left unpaid. */
    owes?: number
    /** Amount paid toward the last month (instead of the full rent). */
    partial?: number
}

export interface SeedRequest {
    unit: string
    /** Email of the tenant who filed it; leave out for one the office filed. */
    by?: string
    title: string
    description?: string
    status: "submitted" | "in_progress" | "resolved"
    filed: string
}

export interface SeedProperty {
    name: string
    address: string
    /** Unit number → its current lease, or `VACANT`. */
    units: Record<string, SeedLease | typeof VACANT>
    maintenance?: SeedRequest[]
}

export interface SeedData {
    /** `maintenance`: a maintenance staff login (the queue only) instead of a property manager. */
    staff: Array<{ name: string; email: string; maintenance?: boolean }>
    properties: SeedProperty[]
}

export const VACANT = null

/** Date helpers handed to the data below; `today` is the day of seeding. */
export interface Dates {
    /** The `day` of the month, `n` months back (0 = this month). */
    monthsAgo(n: number, day?: number): string
    /** `n` days back, at `hour` local-ish (UTC) time. */
    daysAgo(n: number, hour?: number): string
}

/** The tenant most testing signs in as. */
const TEST_TENANT: SeedTenant = { name: "Test Tenant", email: "tenant@example.com", phone: "(575) 555-0101" }

/** The full sample portfolio: two properties, 18 units, 14 leases, requests in every status. */
export const sample = ({ monthsAgo, daysAgo }: Dates): SeedData => ({
    staff: [
        { name: "Dana Whitfield", email: "manager@example.com" },
        { name: "Luis Ortega", email: "maintenance@example.com", maintenance: true },
    ],
    properties: [
        {
            name: "Woodcrest Apartments",
            address: "2400 Woodcrest Dr, Las Cruces, NM 88011",
            units: {
                "101": { rent: 950, since: monthsAgo(1), tenants: [TEST_TENANT], owes: 1 },
                "102": { rent: 910, since: monthsAgo(7), tenants: [{ name: "James Johnson", email: "james.johnson@example.com", phone: "(575) 555-0102" }], owes: 2 },
                "103": { rent: 975, since: monthsAgo(9), tenants: [{ name: "Aisha Okafor", email: "aisha.okafor@example.com", phone: "(575) 555-0103" }] },
                "104": { rent: 1020, since: monthsAgo(5, 15), tenants: [{ name: "Diego Fitzgerald", email: "diego.f@example.com" }], partial: 520 },
                "105": {
                    rent: 1180, since: monthsAgo(8), tenants: [
                        { name: "Sarah Alvarez", email: "sarah.alvarez@example.com", phone: "(575) 555-0105" },
                        { name: "Marco Alvarez", email: "marco.alvarez@example.com", phone: "(575) 555-0115" },
                    ],
                },
                "106": { rent: 950, since: monthsAgo(4), tenants: [{ name: "Priya Sharma", email: "priya.sharma@example.com", phone: "(575) 555-0106" }] },
                "107": { rent: 990, since: monthsAgo(2), tenants: [{ name: "Raj Johnson", email: "raj.johnson@example.com" }], owes: 1 },
                "108": VACANT,
                "109": { rent: 1050, since: monthsAgo(11), tenants: [{ name: "Elena Alvarez", email: "elena.alvarez@example.com", phone: "(575) 555-0109" }] },
                "110": { rent: 1210, since: monthsAgo(6), tenants: [{ name: "Chen Wei", email: "chen.wei@example.com", phone: "(575) 555-0110" }] },
                "111": { rent: 930, since: monthsAgo(0), tenants: [{ name: "Nora Brooks", email: "nora.brooks@example.com", invited: true }], owes: 1 },
                "112": VACANT,
            },
            maintenance: [
                { unit: "101", by: "tenant@example.com", title: "Kitchen faucet leaking", description: "Steady drip under the sink, worse in the morning.", status: "in_progress", filed: daysAgo(17) },
                { unit: "101", by: "tenant@example.com", title: "Dishwasher clogged", description: "Water pools at the bottom after a full cycle.", status: "resolved", filed: daysAgo(62) },
                { unit: "106", by: "priya.sharma@example.com", title: "No heat, apartment is 52 degrees", description: "The heater turns on but blows cold air.", status: "submitted", filed: daysAgo(12, 7) },
                { unit: "103", by: "aisha.okafor@example.com", title: "Front door deadbolt sticking", description: "Hard to lock from outside.", status: "resolved", filed: daysAgo(15, 15) },
                { unit: "110", by: "chen.wei@example.com", title: "Bathroom fan is loud", description: "Rattles when it is on.", status: "submitted", filed: daysAgo(10, 18) },
            ],
        },
        {
            name: "Mesilla Court",
            address: "118 Calle de Guadalupe, Mesilla, NM 88046",
            units: {
                A1: { rent: 1350, since: monthsAgo(8), tenants: [{ name: "Tom Nguyen", email: "tom.nguyen@example.com", phone: "(575) 555-0201" }] },
                A2: { rent: 1290, since: monthsAgo(3), tenants: [{ name: "Lucia Reyes", email: "lucia.reyes@example.com", phone: "(575) 555-0202" }], owes: 1 },
                A3: VACANT,
                A4: { rent: 1400, since: monthsAgo(7), tenants: [{ name: "Ben Osei", email: "ben.osei@example.com", phone: "(575) 555-0204" }] },
                A5: { rent: 1325, since: monthsAgo(1), tenants: [{ name: "Hana Tanaka", email: "hana.tanaka@example.com" }] },
                A6: VACANT,
            },
            maintenance: [
                { unit: "A3", title: "Water heater leaking into hallway", description: "Reported by the office after inspection.", status: "in_progress", filed: daysAgo(11) },
            ],
        },
    ],
})

/** A clean start (for presenting, or a fresh hosted copy): the manager, maintenance staff, one tenant on Unit 101 owing this month, three empty units. */
export const clean = ({ monthsAgo }: Dates): SeedData => ({
    staff: [
        { name: "Dana Whitfield", email: "manager@example.com" },
        { name: "Luis Ortega", email: "maintenance@example.com", maintenance: true },
    ],
    properties: [{
        name: "Woodcrest Apartments",
        address: "2400 Woodcrest Dr, Las Cruces, NM 88011",
        units: {
            "101": { rent: 950, since: monthsAgo(0), tenants: [TEST_TENANT], owes: 1 },
            "102": VACANT,
            "103": VACANT,
            "104": VACANT,
        },
    }],
})

export const DATASETS = { sample, clean }
