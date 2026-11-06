/*
 * The money logic behind the Finance and Performance screens, as plain
 * functions over store records (no database), so it can be tested directly.
 *
 * Payments are not tied to charges in the schema, so each lease's payments
 * are applied to its charges oldest-due first, the usual practice. That is
 * what tells us which charges are paid, which are late, how late, and what
 * each payment was "for". A refund takes money back off the charges it was
 * most recently applied to. Totals stay equal to the ledger: for every lease,
 * (charged − applied) − credit = the `lease_balance` balance.
 */
import type { ChargeRecord, PaymentRecord } from "../types/records"
import type { AgingBuckets, ExpenseCategory, ExpenseRecord, FinancePeriod, MonthRow, PeriodInfo } from "../types/finance"

/** A charge counts as late this many days after its due date. (An open question for Summit: their grace period.) */
export const LATE_AFTER_DAYS = 0

const cents = (dollars: number) => Math.round(dollars * 100)
const dollars = (c: number) => c / 100
const DAY = 86_400_000

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

export const CHARGE_KIND_LABELS: Record<string, string> = {
    rent: "Rent",
    late_fee: "Late fees",
    utility: "Utilities",
    deposit: "Security deposits",
    proration: "Prorated rent",
    parking: "Parking",
    hoa: "HOA fees",
    repair: "Repairs billed to residents",
    non_compliance: "Non-compliance fees",
    misc_income: "Miscellaneous income",
    other: "Other charges",
}

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
    repairs: "Repairs & maintenance",
    utilities: "Utilities",
    insurance: "Insurance",
    taxes: "Property taxes",
    mortgage: "Mortgage interest",
    management: "Management & payroll",
    supplies: "Supplies",
    legal: "Legal & professional",
    marketing: "Advertising",
    other: "Other",
}

// ---- Applying payments to charges

export interface Application {
    paymentId: number
    /** ISO timestamp of the payment. */
    at: Date
    cents: number
}

export interface AllocatedCharge {
    charge: ChargeRecord
    appliedCents: number
    applications: Application[]
    /** When it was paid in full (the last application), or null while open. */
    paidInFullAt: Date | null
}

export interface AllocatedPayment {
    payment: PaymentRecord
    /** The charges it went to, in order. */
    applied: Array<{ chargeId: number; cents: number }>
    /** The part that went to no charge (paid ahead), after later refunds. */
    unappliedCents: number
}

export interface LeaseAllocation {
    charges: AllocatedCharge[]
    payments: AllocatedPayment[]
    /** Paid ahead and not used yet. */
    creditCents: number
}

/** One lease's charges and payments (completed only). */
export function allocate(charges: ChargeRecord[], payments: PaymentRecord[]): LeaseAllocation {
    const open = [...charges]
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id - b.id)
        .map<AllocatedCharge>((charge) => ({ charge, appliedCents: 0, applications: [], paidInFullAt: null }))
    const done = payments.filter((p) => p.status === "completed").sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.id - b.id)
    const allocated: AllocatedPayment[] = []
    // Money paid ahead, as (payment, cents) so it can be applied later and still say where it came from.
    let credit: Array<{ payment: AllocatedPayment; cents: number }> = []

    const applyTo = (item: AllocatedPayment, amount: number, at: Date): number => {
        let left = amount
        for (const c of open) {
            if (left <= 0) break
            const due = cents(c.charge.amount) - c.appliedCents
            if (due <= 0) continue
            const take = Math.min(due, left)
            c.appliedCents += take
            c.applications.push({ paymentId: item.payment.id, at, cents: take })
            if (c.appliedCents >= cents(c.charge.amount)) c.paidInFullAt = at
            item.applied.push({ chargeId: c.charge.id, cents: take })
            left -= take
        }
        return left
    }

    for (const p of done) {
        if (p.direction === "charge") {
            const item: AllocatedPayment = { payment: p, applied: [], unappliedCents: 0 }
            allocated.push(item)
            const left = applyTo(item, cents(p.amount), p.paidAt)
            if (left > 0) {
                item.unappliedCents = left
                credit.push({ payment: item, cents: left })
            }
        } else {
            const item: AllocatedPayment = { payment: p, applied: [], unappliedCents: 0 }
            allocated.push(item)
            // A refund comes out of unused credit first, then off the most recently applied charges.
            let left = cents(p.amount)
            for (let i = credit.length - 1; i >= 0 && left > 0; i--) {
                const take = Math.min(credit[i]!.cents, left)
                credit[i]!.cents -= take
                credit[i]!.payment.unappliedCents -= take
                left -= take
            }
            credit = credit.filter((c) => c.cents > 0)
            const applications = open
                .flatMap((c) => c.applications.map((a) => ({ c, a })))
                .sort((x, y) => y.a.at.getTime() - x.a.at.getTime())
            for (const { c, a } of applications) {
                if (left <= 0) break
                const take = Math.min(a.cents, left)
                a.cents -= take
                c.appliedCents -= take
                c.paidInFullAt = null
                left -= take
            }
            for (const c of open) c.applications = c.applications.filter((a) => a.cents > 0)
        }
    }

    // Money paid ahead goes to charges that were billed later (a tenant who prepaid next month).
    for (const c of credit) {
        if (c.cents <= 0) continue
        const before = c.cents
        const left = applyTo(c.payment, c.cents, c.payment.payment.paidAt)
        c.payment.unappliedCents -= before - left
        c.cents = left
    }
    return { charges: open, payments: allocated, creditCents: credit.reduce((sum, c) => sum + c.cents, 0) }
}

// ---- Aging

const emptyAging = (): AgingBuckets => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 })

/** Unpaid amounts by days past due, as of `today`. */
export function aging(charges: AllocatedCharge[], today: string, lateAfterDays = LATE_AFTER_DAYS): AgingBuckets & { oldestUnpaidDue: string | null; daysLate: number } {
    const out = { ...emptyAging(), oldestUnpaidDue: null as string | null, daysLate: 0 }
    const c = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }
    for (const ch of charges) {
        const unpaid = cents(ch.charge.amount) - ch.appliedCents
        if (unpaid <= 0) continue
        out.oldestUnpaidDue ??= ch.charge.dueDate
        const late = daysBetween(ch.charge.dueDate, today) - lateAfterDays
        if (late <= 0) c.current += unpaid
        else if (late <= 30) c.d1_30 += unpaid
        else if (late <= 60) c.d31_60 += unpaid
        else if (late <= 90) c.d61_90 += unpaid
        else c.d90plus += unpaid
    }
    if (out.oldestUnpaidDue) out.daysLate = Math.max(0, daysBetween(out.oldestUnpaidDue, today) - lateAfterDays)
    out.current = dollars(c.current)
    out.d1_30 = dollars(c.d1_30)
    out.d31_60 = dollars(c.d31_60)
    out.d61_90 = dollars(c.d61_90)
    out.d90plus = dollars(c.d90plus)
    out.total = dollars(c.current + c.d1_30 + c.d31_60 + c.d61_90 + c.d90plus)
    return out
}

export function sumAging(rows: AgingBuckets[]): AgingBuckets {
    const out = emptyAging()
    for (const r of rows) {
        out.current += cents(r.current)
        out.d1_30 += cents(r.d1_30)
        out.d31_60 += cents(r.d31_60)
        out.d61_90 += cents(r.d61_90)
        out.d90plus += cents(r.d90plus)
    }
    const total = out.current + out.d1_30 + out.d31_60 + out.d61_90 + out.d90plus
    return { current: dollars(out.current), d1_30: dollars(out.d1_30), d31_60: dollars(out.d31_60), d61_90: dollars(out.d61_90), d90plus: dollars(out.d90plus), total: dollars(total) }
}

// ---- Periods and months

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export const monthKey = (date: string) => date.slice(0, 7)
export const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`

/** The last `count` months ending with today's, oldest first: ["2025-11", …, "2026-10"]. */
export function lastMonths(today: string, count: number): string[] {
    const y = Number(today.slice(0, 4))
    const m = Number(today.slice(5, 7)) - 1
    const out: string[] = []
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - i, 1))
        out.push(d.toISOString().slice(0, 7))
    }
    return out
}

/** The last day of a month ("2026-02" → "2026-02-28"). */
export const monthEnd = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10)

export function periodOf(key: FinancePeriod, today: string): PeriodInfo {
    switch (key) {
        case "this-month": return { key, label: `${monthLabel(monthKey(today))} to date`, from: `${monthKey(today)}-01`, to: today }
        case "30d": return { key, label: "Last 30 days", from: addDays(today, -29), to: today }
        case "90d": return { key, label: "Last 90 days", from: addDays(today, -89), to: today }
        case "ytd": return { key, label: `${today.slice(0, 4)} year to date`, from: `${today.slice(0, 4)}-01-01`, to: today }
        case "12m": {
            const first = lastMonths(today, 12)[0]!
            return { key, label: "Last 12 months", from: `${first}-01`, to: today }
        }
    }
}

export const isPeriod = (value: unknown): value is FinancePeriod =>
    value === "this-month" || value === "30d" || value === "90d" || value === "ytd" || value === "12m"

/** A payment's local date, as the office sees it. */
export const localDay = (at: Date, timeZone: string) => at.toLocaleDateString("en-CA", { timeZone })

export const inRange = (date: string, from: string, to: string) => date >= from && date <= to

// ---- Monthly income vs. expenses

export function monthlyRows(input: {
    months: string[]
    charges: ChargeRecord[]
    payments: PaymentRecord[]
    expenses: ExpenseRecord[]
    timeZone: string
}): MonthRow[] {
    const rows = new Map(input.months.map((m) => [m, { billed: 0, collected: 0, expenses: 0 }]))
    for (const c of input.charges) {
        const r = rows.get(monthKey(c.dueDate))
        if (r) r.billed += cents(c.amount)
    }
    for (const p of input.payments) {
        if (p.status !== "completed") continue
        const r = rows.get(monthKey(localDay(p.paidAt, input.timeZone)))
        if (r) r.collected += p.direction === "refund" ? -cents(p.amount) : cents(p.amount)
    }
    for (const e of input.expenses) {
        const r = rows.get(monthKey(e.spentOn))
        if (r) r.expenses += cents(e.amount)
    }
    return input.months.map((month) => {
        const r = rows.get(month)!
        return { month, label: monthLabel(month), billed: dollars(r.billed), collected: dollars(r.collected), expenses: dollars(r.expenses), net: dollars(r.collected - r.expenses) }
    })
}

export const round2 = (n: number) => Math.round(n * 100) / 100
export const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0)
export { cents, dollars }
