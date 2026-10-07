import type { LedgerEntry } from "../types/tenant"

/**
 * The tenant's ledger, built from Angel's tables as they are: a lease's
 * ammount_owed is read as the monthly rent, charged on the 1st of every month
 * from the lease's first month to this one (and not after end_date), and
 * every Payment row on the lease is a credit. Newest first, each line with the
 * balance after it, the way Juan's Ledger page shows it.
 *
 * When Angel adds a real ledger table this function is what gets replaced; the
 * API's shape stays the same.
 */

export interface LeaseTerms {
    startDate: string        // YYYY-MM-DD
    endDate: string | null
    monthlyRent: number      // dollars
}

export interface PaymentLine {
    id: number
    amount: number           // dollars
    paidAt: Date
    method: string | null
    confirmation: string | null
}

const cents = (dollars: number) => Math.round(dollars * 100)

export function formatDate(date: Date, timeZone = "America/Denver"): string {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone })
}

const monthName = (date: Date) => date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })

/** First-of-month charge dates (UTC midnight) from the lease start through `today`. */
export function rentCharges(lease: LeaseTerms, today: Date): Date[] {
    const start = new Date(`${lease.startDate}T00:00:00Z`)
    const end = lease.endDate ? new Date(`${lease.endDate}T00:00:00Z`) : null
    const out: Date[] = []
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
    while (cursor <= today && (!end || cursor <= end)) {
        // The first month is charged on the move-in date, not before it.
        out.push(out.length === 0 ? new Date(start) : new Date(cursor))
        cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    return out
}

export function buildLedger(lease: LeaseTerms, payments: PaymentLine[], today: Date, timeZone?: string): {
    entries: LedgerEntry[]
    balance: number
} {
    type Line = { at: Date; order: number; entry: Omit<LedgerEntry, "balanceAfter"> }
    const lines: Line[] = []

    for (const at of rentCharges(lease, today)) {
        lines.push({
            at,
            order: 0,
            entry: {
                id: `charge-${at.toISOString().slice(0, 7)}`,
                date: formatDate(at, "UTC"),
                description: `Rent charge - ${monthName(at)}`,
                method: null,
                amount: -lease.monthlyRent,
            },
        })
    }

    for (const payment of payments) {
        lines.push({
            at: payment.paidAt,
            order: 1,
            entry: {
                id: `payment-${payment.id}`,
                date: formatDate(payment.paidAt, timeZone),
                description: "Payment received",
                method: payment.method,
                amount: payment.amount,
                ...(payment.confirmation ? { confirmation: payment.confirmation } : {}),
            },
        })
    }

    lines.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order)

    let owedCents = 0
    const entries = lines.map((line) => {
        owedCents -= cents(line.entry.amount)
        return { ...line.entry, balanceAfter: owedCents / 100 }
    })

    return { entries: entries.reverse(), balance: owedCents / 100 }
}

/** "November 1" and "Nov 5": when the money is due and when a late fee could start (the 5th, per the client). */
export function dueDates(balance: number, today: Date): { rentDueDate: string; lateFeeGraceDate: string } {
    const due = balance > 0
        ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
        : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
    const grace = new Date(due)
    grace.setUTCDate(5)
    return {
        rentDueDate: due.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }),
        lateFeeGraceDate: grace.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    }
}
