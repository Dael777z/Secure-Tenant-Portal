import type { ChargeRecord, PaymentRecord } from "../types/records"
import type { LedgerEntry } from "../types/tenant"

/**
 * The ledger the pages show: Charge rows (owed) and Payment rows (paid or
 * refunded) as one list, newest first, each line with the balance after it.
 * Charges are negative, payments positive. The balance is computed the same
 * way as the schema's `lease_balance` view: charged - paid + refunded,
 * completed payments only.
 */

/*

Generates all the ledger data the frontend needs to display, takes in a list of charge & payment records for balance.


*/


const cents = (dollars: number) => Math.round(dollars * 100)

export function formatDate(date: Date, timeZone = "America/Denver"): string {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone })
}

/** "Today" as YYYY-MM-DD in the portal's time zone (what a DATE column compares against). */
export function localDate(now: Date, timeZone: string): string {
    return now.toLocaleDateString("en-CA", { timeZone })
}

const CHARGE_LABELS: Record<ChargeRecord["kind"], string> = {
    rent: "Rent charge",
    deposit: "Security deposit",
    late_fee: "Late fee",
    utility: "Utility charge",
    proration: "Prorated rent",
    other: "Charge",
    parking: "Parking",
    hoa: "HOA fee",
    repair: "Repair charge",
    non_compliance: "Non-compliance fee",
    misc_income: "Charge",
}

export function buildLedger(charges: ChargeRecord[], payments: PaymentRecord[], timeZone?: string): {
    entries: LedgerEntry[]
    balance: number
} {
    type Line = { at: Date; order: number; entry: Omit<LedgerEntry, "balanceAfter"> }
    const lines: Line[] = []

    for (const charge of charges) {
        const at = new Date(`${charge.dueDate}T00:00:00Z`)
        lines.push({
            at,
            order: 0,
            entry: {
                id: `charge-${charge.id}`,
                date: formatDate(at, "UTC"),
                description: charge.description ?? CHARGE_LABELS[charge.kind],
                method: null,
                amount: -charge.amount,
            },
        })
    }

    // Only completed payments move the balance
    for (const payment of payments.filter((p) => p.status === "completed")) {
        const refund = payment.direction === "refund"
        lines.push({
            at: payment.paidAt,
            order: 1,
            entry: {
                // "payment-<id>" is what receipts are keyed by.
                id: `payment-${payment.id}`,
                date: formatDate(payment.paidAt, timeZone),
                description: refund ? "Payment reversed" : "Payment received",
                method: payment.method,
                amount: refund ? -payment.amount : payment.amount,
                confirmation: payment.confirmation,
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


/** The day of month a lease bills rent on: its start day, or the month's last day when the month is shorter (007). */
function rentDayIn(year: number, month: number, startDay: number): Date {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return new Date(Date.UTC(year, month, Math.min(startDay, last)))
}

/**
 * When rent is due and when a late fee could start (4 days later). Rent is due
 * on the lease's start day each month (007): with a balance, the latest due day
 * so far; paid up, the next one. Without a lease start, the 1st.
 */
export function dueDates(balance: number, today: Date, leaseStart?: string | null): { rentDueDate: string; lateFeeGraceDate: string } {
    const startDay = leaseStart ? Number(leaseStart.slice(8, 10)) : 1
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    let due = rentDayIn(day.getUTCFullYear(), day.getUTCMonth(), startDay)
    if (balance > 0 && due > day) due = rentDayIn(day.getUTCFullYear(), day.getUTCMonth() - 1, startDay)
    if (balance <= 0 && due <= day) due = rentDayIn(day.getUTCFullYear(), day.getUTCMonth() + 1, startDay)
    const grace = new Date(due)
    grace.setUTCDate(grace.getUTCDate() + 4)
    return {
        rentDueDate: due.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }),
        lateFeeGraceDate: grace.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    }
}
