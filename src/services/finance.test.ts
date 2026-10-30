import { describe, expect, it } from "vitest"

import type { ChargeRecord, PaymentRecord } from "../types/records"
import { aging, allocate, lastMonths, monthlyRows, periodOf } from "./finance"

const charge = (id: number, dueDate: string, amount: number, kind: ChargeRecord["kind"] = "rent"): ChargeRecord =>
    ({ id, leaseId: 1, kind, amount, dueDate, description: null })
const pay = (id: number, at: string, amount: number, direction: "charge" | "refund" = "charge"): PaymentRecord =>
    ({ id, leaseId: 1, direction, status: "completed", amount, paidAt: new Date(`${at}T18:00:00Z`), method: "Bank transfer", confirmation: `C-${id}`, payerId: 7 })

describe("allocate: payments go to the oldest charges first", () => {
    it("pays charges in due-date order and marks when each was paid in full", () => {
        const a = allocate([charge(2, "2026-09-01", 900), charge(1, "2026-08-01", 900)], [pay(10, "2026-08-03", 900), pay(11, "2026-09-10", 500)])
        const [aug, sep] = a.charges
        expect(aug!.charge.id).toBe(1)
        expect(aug!.appliedCents).toBe(90000)
        expect(aug!.paidInFullAt?.toISOString().slice(0, 10)).toBe("2026-08-03")
        expect(sep!.appliedCents).toBe(50000)
        expect(sep!.paidInFullAt).toBeNull()
        expect(a.creditCents).toBe(0)
    })

    it("keeps money paid ahead as credit when nothing is due", () => {
        const a = allocate([charge(1, "2026-08-01", 900)], [pay(10, "2026-08-01", 1000)])
        expect(a.creditCents).toBe(10000)
        expect(a.payments[0]!.unappliedCents).toBe(10000)
    })

    it("a refund takes money back off the most recently paid charge", () => {
        const a = allocate([charge(1, "2026-08-01", 900), charge(2, "2026-09-01", 900)], [pay(10, "2026-08-02", 900), pay(11, "2026-09-02", 900), pay(12, "2026-09-05", 900, "refund")])
        expect(a.charges[0]!.appliedCents).toBe(90000)
        expect(a.charges[1]!.appliedCents).toBe(0)
        expect(a.charges[1]!.paidInFullAt).toBeNull()
    })

    it("ignores payments that did not complete", () => {
        const failed = { ...pay(10, "2026-08-02", 900), status: "failed" as const }
        expect(allocate([charge(1, "2026-08-01", 900)], [failed]).charges[0]!.appliedCents).toBe(0)
    })
})

describe("aging", () => {
    it("buckets what is unpaid by days past due", () => {
        const a = allocate([
            charge(1, "2026-06-01", 100), charge(2, "2026-08-10", 100), charge(3, "2026-09-10", 100),
            charge(4, "2026-10-05", 100), charge(5, "2026-10-21", 100),
        ], [])
        const age = aging(a.charges, "2026-10-21", 0)
        expect(age).toMatchObject({ d90plus: 100, d61_90: 100, d31_60: 100, d1_30: 100, current: 100, total: 500, oldestUnpaidDue: "2026-06-01", daysLate: 142 })
    })

    it("a grace period keeps a just-due charge current", () => {
        const age = aging(allocate([charge(1, "2026-10-18", 100)], []).charges, "2026-10-21", 5)
        expect(age).toMatchObject({ current: 100, d1_30: 0, daysLate: 0 })
    })
})

describe("periods and months", () => {
    it("this month starts on the 1st; 12 months covers a year of month keys", () => {
        expect(periodOf("this-month", "2026-10-21")).toMatchObject({ from: "2026-10-01", to: "2026-10-21" })
        expect(periodOf("30d", "2026-10-21").from).toBe("2026-09-22")
        expect(lastMonths("2026-02-15", 3)).toEqual(["2025-12", "2026-01", "2026-02"])
    })

    it("monthly rows: billed by due date, collected net of refunds, expenses by date", () => {
        const rows = monthlyRows({
            months: ["2026-09", "2026-10"],
            charges: [charge(1, "2026-09-01", 900), charge(2, "2026-10-01", 900)],
            payments: [pay(10, "2026-09-02", 900), pay(11, "2026-10-02", 900), pay(12, "2026-10-03", 100, "refund")],
            expenses: [{ id: 1, propertyId: 1, propertyName: "P", unitId: null, unitNum: null, category: "repairs", amount: 250, spentOn: "2026-10-05", vendor: null, description: null, createdBy: null }],
            timeZone: "America/Denver",
        })
        expect(rows).toEqual([
            { month: "2026-09", label: "Sep 2026", billed: 900, collected: 900, expenses: 0, net: 900 },
            { month: "2026-10", label: "Oct 2026", billed: 900, collected: 800, expenses: 250, net: 550 },
        ])
    })
})
