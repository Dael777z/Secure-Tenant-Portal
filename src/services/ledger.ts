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
