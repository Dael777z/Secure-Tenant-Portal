import { describe, expect, it } from "vitest"

import { addMonths, feeFor, lateFeeSchedule } from "./operations-service"
import { typeAndPriority } from "./tenant-service"

describe("repeating charges (addMonths)", () => {
    it("keeps the day of the month, using the last day of shorter months", () => {
        expect(addMonths("2026-01-31", 1)).toBe("2026-02-28")
        expect(addMonths("2028-01-31", 1)).toBe("2028-02-29")
        expect(addMonths("2026-01-31", 2)).toBe("2026-03-31")
        expect(addMonths("2026-11-15", 3)).toBe("2027-02-15")
        expect(addMonths("2026-10-01", 0)).toBe("2026-10-01")
    })
})

describe("late fees", () => {
    const rule = { graceDays: 5, firstAmount: 50, firstType: "flat" as const, dailyAmount: 10, dailyType: "flat" as const, maxAmount: 100, maxType: "flat" as const }

    it("a fee is flat, or a percent of the rent to the cent", () => {
        expect(feeFor(50, "flat", 1200)).toBe(50)
        expect(feeFor(5, "percent", 1290)).toBe(64.5)
        expect(feeFor(3.5, "percent", 999.99)).toBe(35)
    })

    it("charges the first fee on the grace day, then the daily fee, up to the limit", () => {
        const days = lateFeeSchedule(rule, 1000, 15)
        expect(days.slice(0, 5).every((d) => d.fee === 0)).toBe(true)
        expect(days[5]).toEqual({ daysLate: 5, fee: 50, total: 50 })
        expect(days[6]).toEqual({ daysLate: 6, fee: 10, total: 60 })
        expect(days[10]!.total).toBe(100)
        expect(days[11]!.fee).toBe(0)                       // the limit is reached
        expect(days.at(-1)!.total).toBe(100)
    })

    it("the last fee is cut to fit the limit, and no limit means no limit", () => {
        expect(lateFeeSchedule({ ...rule, maxAmount: 75 }, 1000, 10).map((d) => d.fee).slice(5, 9)).toEqual([50, 10, 10, 5])
        expect(lateFeeSchedule({ ...rule, maxAmount: null }, 1000, 30).at(-1)!.total).toBe(50 + 25 * 10)
    })

    it("percent fees and limits are taken from the rent", () => {
        const pct = lateFeeSchedule({ graceDays: 0, firstAmount: 5, firstType: "percent", dailyAmount: 1, dailyType: "percent", maxAmount: 10, maxType: "percent" }, 1500, 20)
        expect(pct[0]).toEqual({ daysLate: 0, fee: 75, total: 75 })
        expect(pct[1]!.fee).toBe(15)
        expect(pct.at(-1)!.total).toBe(150)
    })
})

describe("a tenant's maintenance form (typeAndPriority)", () => {
    it("reads the category and urgency Juan's form writes", () => {
        expect(typeAndPriority("Category: plumbing | Urgency: urgent | Under the sink")).toEqual({ requestType: "plumbing", priority: "high" })
        expect(typeAndPriority("Category: hvac | Urgency: soon")).toEqual({ requestType: "hvac", priority: "medium" })
        expect(typeAndPriority("Category: appliance | Urgency: routine")).toEqual({ requestType: "appliance", priority: "low" })
    })

    it("falls back to 'other' and no priority for anything else", () => {
        expect(typeAndPriority("The door squeaks")).toEqual({ requestType: "other", priority: "none" })
        expect(typeAndPriority("Category: roof | Urgency: whenever")).toEqual({ requestType: "other", priority: "none" })
    })
})
