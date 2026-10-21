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


// Passwords for seed accounts
export const PASSWORDS = {
    staff: "manager-demo-password",
    tenant: "tenant-demo-password",
}

// Seeded tenant
export interface SeedTenant {
    name: string
    email: string
    phone?: string
    /** On the lease but not signed up yet. */
    invited?: boolean
}

// Seeded lease 
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

// Seeded maintenance request
export interface SeedRequest {
    unit: string
    /** Email of the tenant who filed it; leave out for one the office filed. */
    by?: string
    title: string
    description?: string
    status: "submitted" | "in_progress" | "resolved"
    filed: string
}

// Seeded property
export interface SeedProperty {
    name: string
    address: string
    /** Unit number → its current lease, or `VACANT`. */
    units: Record<string, SeedLease | typeof VACANT>
    maintenance?: SeedRequest[]
    /** Money spent on this property (005), for Profit & Loss. */
    expenses?: SeedExpense[]
}

// Seeded staff & properties struct
export interface SeedData {
    /** `maintenance`: a maintenance staff login (the queue only) instead of a property manager. */
    staff: Array<{ name: string; email: string; maintenance?: boolean }>
    /** Expenses for the whole portfolio, not one property (insurance, software). */
    expenses?: SeedExpense[]
    properties: SeedProperty[]
}

export const VACANT = null


// Find how many days or months ago a given day is from today as a string.
export interface Dates {
    
    // month code, day of the month (of date to check)
    monthsAgo(n: number, day?: number): string
    // day of the month and hour (of date to check)
    daysAgo(n: number, hour?: number): string
    /** `n` days from today, YYYY-MM-DD (a lease end coming up). */
    daysAhead(n: number): string
}

/** An expense (005). `on` is YYYY-MM-DD; `unit` optionally ties it to one unit of the property. */
export interface SeedExpense {
    category: "repairs" | "utilities" | "insurance" | "taxes" | "mortgage" | "management" | "supplies" | "legal" | "marketing" | "other"
    amount: number
    on: string
    vendor?: string
    description?: string
    unit?: string
}

/** The same expense every month for the last `months` months (oldest first), on `day`, never after today. */
export function everyMonth(dates: Dates, months: number, day: number, make: (i: number) => Omit<SeedExpense, "on">): SeedExpense[] {
    const out: SeedExpense[] = []
    for (let n = months - 1; n >= 0; n--) {
        const on = dates.monthsAgo(n, day)
        if (on <= dates.daysAgo(0).slice(0, 10)) out.push({ ...make(n), on })
    }
    return out
}

// Test tenant to control
const TEST_TENANT: SeedTenant = { name: "Test Tenant", email: "tenant@example.com", phone: "(575) 555-0101" }

// Sample portfolio: two properties, 18 units, 14 leases, requests in every status.
export const sample = (dates: Dates): SeedData => {
    const { monthsAgo, daysAgo, daysAhead } = dates
    return {
    staff: [
        { name: "Dana Whitfield", email: "manager@example.com" },
        { name: "Luis Ortega", email: "maintenance@example.com", maintenance: true },
    ],
    // Expenses for the whole portfolio (005): software and an umbrella policy.
    expenses: [
        ...everyMonth(dates, 12, 3, () => ({ category: "other", amount: 79, vendor: "Summit portal hosting", description: "Software and hosting" })),
        { category: "insurance", amount: 1840, on: monthsAgo(9, 15), vendor: "Rio Grande Mutual", description: "Umbrella liability policy (annual)" },
    ],
    properties: [
        {
            name: "Woodcrest Apartments",
            address: "2400 Woodcrest Dr, Las Cruces, NM 88011",
            units: {
                "101": { rent: 950, since: monthsAgo(1), tenants: [TEST_TENANT], owes: 1 },
                "102": { rent: 910, since: monthsAgo(7), until: daysAhead(25), tenants: [{ name: "James Johnson", email: "james.johnson@example.com", phone: "(575) 555-0102" }], owes: 2 },
                "103": { rent: 975, since: monthsAgo(9), tenants: [{ name: "Aisha Okafor", email: "aisha.okafor@example.com", phone: "(575) 555-0103" }] },
                "104": { rent: 1020, since: monthsAgo(5, 15), tenants: [{ name: "Diego Fitzgerald", email: "diego.f@example.com" }], partial: 520 },
                "105": {
                    rent: 1180, since: monthsAgo(8), tenants: [
                        { name: "Sarah Alvarez", email: "sarah.alvarez@example.com", phone: "(575) 555-0105" },
                        { name: "Marco Alvarez", email: "marco.alvarez@example.com", phone: "(575) 555-0115" },
                    ],
                },
                "106": { rent: 950, since: monthsAgo(4), until: daysAhead(58), tenants: [{ name: "Priya Sharma", email: "priya.sharma@example.com", phone: "(575) 555-0106" }] },
                "107": { rent: 990, since: monthsAgo(2), tenants: [{ name: "Raj Johnson", email: "raj.johnson@example.com" }], owes: 1 },
                "108": VACANT,
                "109": { rent: 1050, since: monthsAgo(11), until: daysAhead(140), tenants: [{ name: "Elena Alvarez", email: "elena.alvarez@example.com", phone: "(575) 555-0109" }] },
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
            expenses: [
                ...everyMonth(dates, 12, 6, (n) => ({ category: "utilities", amount: 365 + ((n * 37) % 90), vendor: "City of Las Cruces Utilities", description: "Water, sewer and trash" })),
                ...everyMonth(dates, 12, 28, () => ({ category: "management", amount: 600, vendor: "On-site staff", description: "Maintenance staff payroll (share)" })),
                { category: "insurance", amount: 1250, on: monthsAgo(10, 10), vendor: "Rio Grande Mutual", description: "Property insurance, quarterly" },
                { category: "insurance", amount: 1250, on: monthsAgo(7, 10), vendor: "Rio Grande Mutual", description: "Property insurance, quarterly" },
                { category: "insurance", amount: 1250, on: monthsAgo(4, 10), vendor: "Rio Grande Mutual", description: "Property insurance, quarterly" },
                { category: "insurance", amount: 1250, on: monthsAgo(1, 10), vendor: "Rio Grande Mutual", description: "Property insurance, quarterly" },
                { category: "taxes", amount: 3420, on: monthsAgo(6, 20), vendor: "Doña Ana County Treasurer", description: "Property tax, first half" },
                { category: "repairs", amount: 186.5, on: daysAgo(55).slice(0, 10), vendor: "Mesa Plumbing", description: "Dishwasher drain cleared", unit: "101" },
                { category: "repairs", amount: 94, on: daysAgo(13).slice(0, 10), vendor: "Ace Lock & Key", description: "Deadbolt replaced", unit: "103" },
                { category: "repairs", amount: 2350, on: monthsAgo(5, 22), vendor: "Desert Air HVAC", description: "Rooftop unit compressor", unit: "106" },
                { category: "marketing", amount: 120, on: monthsAgo(2, 4), vendor: "Zillow Rentals", description: "Listing for Units 108 and 112" },
            ],
        },
        {
            name: "Mesilla Court",
            address: "118 Calle de Guadalupe, Mesilla, NM 88046",
            units: {
                A1: { rent: 1350, since: monthsAgo(8), tenants: [{ name: "Tom Nguyen", email: "tom.nguyen@example.com", phone: "(575) 555-0201" }] },
                A2: { rent: 1290, since: monthsAgo(3), tenants: [{ name: "Lucia Reyes", email: "lucia.reyes@example.com", phone: "(575) 555-0202" }], owes: 1 },
                A3: VACANT,
                A4: { rent: 1400, since: monthsAgo(7), until: daysAhead(84), tenants: [{ name: "Ben Osei", email: "ben.osei@example.com", phone: "(575) 555-0204" }] },
                A5: { rent: 1325, since: monthsAgo(1), tenants: [{ name: "Hana Tanaka", email: "hana.tanaka@example.com" }] },
                A6: VACANT,
            },
            maintenance: [
                { unit: "A3", title: "Water heater leaking into hallway", description: "Reported by the office after inspection.", status: "in_progress", filed: daysAgo(11) },
            ],
            expenses: [
                ...everyMonth(dates, 12, 7, (n) => ({ category: "utilities", amount: 228 + ((n * 23) % 60), vendor: "Town of Mesilla", description: "Water and trash" })),
                { category: "repairs", amount: 1180, on: daysAgo(9).slice(0, 10), vendor: "Mesa Plumbing", description: "Water heater replaced", unit: "A3" },
                { category: "supplies", amount: 312.4, on: monthsAgo(3, 12), vendor: "Home Depot", description: "Paint and fixtures for turnover" },
                { category: "taxes", amount: 2780, on: monthsAgo(6, 20), vendor: "Doña Ana County Treasurer", description: "Property tax, first half" },
            ],
        },
    ],
    }
}


// Clean alternative far smaller footprint: the manager, maintenance staff, one tenant on Unit 101 owing this month, three empty units.
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
