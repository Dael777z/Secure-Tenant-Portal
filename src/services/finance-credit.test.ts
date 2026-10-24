import { describe, expect, it } from "vitest"

import type { ChargeRecord, PaymentRecord } from "../types/records"
import { allocate, monthlyRows, periodOf } from "./finance"

const charge = (id: number, dueDate: string, amount: number): ChargeRecord => ({ id, leaseId: 1, kind: "rent", amount, dueDate, description: null })
const pay = (id: number, at: string, amount: number, direction: "charge" | "refund" = "charge", status: PaymentRecord["status"] = "completed"): PaymentRecord =>
    ({ id, leaseId: 1, direction, status, amount, paidAt: new Date(`${at}T18:00:00Z`), method: "Bank transfer", confirmation: `C-${id}`, payerId: 7 })

describe("allocate: money paid ahead", () => {
    it("credit left over goes to a charge billed later", () => {
        const a = allocate([charge(1, "2026-08-01", 900), charge(2, "2026-09-01", 500)], [pay(10, "2026-07-30", 1000)])
        // The payment came before either charge existed in order, so it fills August (900) and the rest waits as credit for September.
        const [aug, sep] = a.charges
        expect(aug!.appliedCents).toBe(90000)
        expect(sep!.appliedCents).toBe(10000)
        expect(a.creditCents).toBe(0)
        expect(a.payments[0]!.unappliedCents).toBe(0)
    })

    it("a refund comes out of unused credit before it touches any paid charge", () => {
        const a = allocate([charge(1, "2026-08-01", 900)], [pay(10, "2026-08-02", 1000), pay(11, "2026-08-05", 150, "refund")])
        // 100 of credit goes back first, then 50 comes off the charge.
        expect(a.creditCents).toBe(0)
        expect(a.charges[0]!.appliedCents).toBe(85000)
        expect(a.charges[0]!.paidInFullAt).toBeNull()
    })
})

describe("periods and monthly rows", () => {
    it("90 days back and the year to date", () => {
        expect(periodOf("90d", "2026-10-21")).toMatchObject({ label: "Last 90 days", from: "2026-07-24", to: "2026-10-21" })
        expect(periodOf("ytd", "2026-10-21")).toMatchObject({ label: "2026 year to date", from: "2026-01-01", to: "2026-10-21" })
    })

    it("a failed or pending payment is not counted as collected", () => {
        const rows = monthlyRows({
            months: ["2026-10"],
            charges: [charge(1, "2026-10-01", 900)],
            payments: [pay(1, "2026-10-02", 900, "charge", "failed"), pay(2, "2026-10-03", 400)],
            expenses: [],
            timeZone: "America/Denver",
        })
        expect(rows[0]).toMatchObject({ month: "2026-10" })
        expect(JSON.stringify(rows[0])).toContain("400")
        expect(JSON.stringify(rows[0])).not.toContain("1300")
    })
})
