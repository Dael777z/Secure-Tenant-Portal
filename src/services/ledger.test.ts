import { describe, expect, it } from "vitest"
import { buildLedger, dueDates, rentCharges } from "./ledger"

const lease = { startDate: "2026-09-15", endDate: null, monthlyRent: 950 }

describe("ledger built from Angel's tables", () => {
    it("charges rent on move-in, then on the 1st of each month up to today", () => {
        const dates = rentCharges(lease, new Date("2026-11-20T12:00:00Z")).map((d) => d.toISOString().slice(0, 10))
        expect(dates).toEqual(["2026-09-15", "2026-10-01", "2026-11-01"])
    })

    it("stops charging after the lease ends", () => {
        const ended = { ...lease, endDate: "2026-10-31" }
        expect(rentCharges(ended, new Date("2027-01-10T00:00:00Z"))).toHaveLength(2)
    })

    it("runs a balance through charges and payments, newest first, in Juan's sign convention", () => {
        const { entries, balance } = buildLedger(
            lease,
            [{ id: 7, amount: 950, paidAt: new Date("2026-09-20T17:00:00Z"), method: "Checking 0000", confirmation: "CONF-1" }],
            new Date("2026-10-02T12:00:00Z"),
        )
        expect(balance).toBe(950)
        expect(entries.map((e) => [e.description, e.amount, e.balanceAfter])).toEqual([
            ["Rent charge - October", -950, 950],
            ["Payment received", 950, 0],
            ["Rent charge - September", -950, 950],
        ])
        expect(entries[1]).toMatchObject({ date: "Sep 20, 2026", method: "Checking 0000", confirmation: "CONF-1" })
    })

    it("keeps cents exact", () => {
        const { balance } = buildLedger(
            { startDate: "2026-10-01", endDate: null, monthlyRent: 1000.1 },
            [{ id: 1, amount: 0.2, paidAt: new Date("2026-10-02T00:00:00Z"), method: null, confirmation: null }],
            new Date("2026-10-03T00:00:00Z"),
        )
        expect(balance).toBe(999.9)
    })

    it("says when rent is due and when a late fee could start", () => {
        expect(dueDates(950, new Date("2026-10-07T00:00:00Z"))).toEqual({ rentDueDate: "October 1", lateFeeGraceDate: "Oct 5" })
        expect(dueDates(0, new Date("2026-10-07T00:00:00Z"))).toEqual({ rentDueDate: "November 1", lateFeeGraceDate: "Nov 5" })
    })
})
