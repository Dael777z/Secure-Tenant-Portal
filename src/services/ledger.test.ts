import { describe, expect, it } from "vitest"
import type { ChargeRecord, PaymentRecord } from "../types/records"
import { buildLedger, dueDates, localDate } from "./ledger"

const rent = (id: number, dueDate: string, amount = 950): ChargeRecord =>
    ({ id, leaseId: 1, kind: "rent", amount, dueDate, description: `Rent - ${dueDate}` })

const payment = (over: Partial<PaymentRecord> & Pick<PaymentRecord, "id" | "amount" | "paidAt">): PaymentRecord => ({
    leaseId: 1, direction: "charge", status: "completed", method: "Checking 0000", confirmation: `CONF-${over.id}`, payerId: null, ...over,
})

describe("ledger built from the Charge and Payment tables", () => {
    it("runs a balance through charges and payments, newest first, charges negative and payments positive", () => {
        const { entries, balance } = buildLedger(
            [rent(1, "2026-09-15"), rent(2, "2026-10-01")],
            [payment({ id: 7, amount: 950, paidAt: new Date("2026-09-20T17:00:00Z") })],
        )
        expect(balance).toBe(950)
        expect(entries.map((e) => [e.description, e.amount, e.balanceAfter])).toEqual([
            ["Rent - 2026-10-01", -950, 950],
            ["Payment received", 950, 0],
            ["Rent - 2026-09-15", -950, 950],
        ])
        expect(entries[1]).toMatchObject({ id: "payment-7", date: "Sep 20, 2026", method: "Checking 0000", confirmation: "CONF-7" })
    })

    it("only completed payments move the balance (the same rule as the lease_balance view)", () => {
        const { entries, balance } = buildLedger(
            [rent(1, "2026-10-01")],
            [
                payment({ id: 1, amount: 950, status: "pending", paidAt: new Date("2026-10-02T00:00:00Z") }),
                payment({ id: 2, amount: 950, status: "failed", paidAt: new Date("2026-10-03T00:00:00Z") }),
            ],
        )
        expect(balance).toBe(950)
        expect(entries).toHaveLength(1)
    })

    it("shows a refund as a reversed payment that puts the money back on the balance", () => {
        const { entries, balance } = buildLedger(
            [rent(1, "2026-10-01")],
            [
                payment({ id: 1, amount: 950, paidAt: new Date("2026-10-02T00:00:00Z") }),
                payment({ id: 2, amount: 950, direction: "refund", paidAt: new Date("2026-10-03T00:00:00Z") }),
            ],
        )
        expect(balance).toBe(950)
        expect(entries[0]).toMatchObject({ description: "Payment reversed", amount: -950, balanceAfter: 950 })
    })

    it("falls back to a label when a charge has no description", () => {
        const { entries } = buildLedger([{ ...rent(1, "2026-10-01"), kind: "late_fee", description: null }], [])
        expect(entries[0]!.description).toBe("Late fee")
    })

    it("keeps cents exact", () => {
        const { balance } = buildLedger(
            [rent(1, "2026-10-01", 1000.1)],
            [payment({ id: 1, amount: 0.2, paidAt: new Date("2026-10-02T00:00:00Z") })],
        )
        expect(balance).toBe(999.9)
    })

    it("says when rent is due and when a late fee could start", () => {
        expect(dueDates(950, new Date("2026-10-07T00:00:00Z"))).toEqual({ rentDueDate: "October 1", lateFeeGraceDate: "Oct 5" })
        expect(dueDates(0, new Date("2026-10-07T00:00:00Z"))).toEqual({ rentDueDate: "November 1", lateFeeGraceDate: "Nov 5" })
    })

    it("uses the lease's start day: due on the 15th for a lease that started on the 15th (007)", () => {
        expect(dueDates(950, new Date("2026-10-20T00:00:00Z"), "2026-08-15")).toEqual({ rentDueDate: "October 15", lateFeeGraceDate: "Oct 19" })
        expect(dueDates(950, new Date("2026-10-07T00:00:00Z"), "2026-08-15")).toEqual({ rentDueDate: "September 15", lateFeeGraceDate: "Sep 19" })
        expect(dueDates(0, new Date("2026-10-07T00:00:00Z"), "2026-08-15")).toEqual({ rentDueDate: "October 15", lateFeeGraceDate: "Oct 19" })
        expect(dueDates(0, new Date("2026-10-15T00:00:00Z"), "2026-08-15")).toEqual({ rentDueDate: "November 15", lateFeeGraceDate: "Nov 19" })
    })

    it("bills a lease that started on the 31st on the last day of shorter months", () => {
        expect(dueDates(0, new Date("2027-02-10T00:00:00Z"), "2026-01-31")).toEqual({ rentDueDate: "February 28", lateFeeGraceDate: "Mar 4" })
    })

    it("works out today's date in the portal's time zone, not UTC", () => {
        // 9pm Oct 15 in Denver is already Oct 16 in UTC.
        expect(localDate(new Date("2026-10-16T03:00:00Z"), "America/Denver")).toBe("2026-10-15")
    })
})
