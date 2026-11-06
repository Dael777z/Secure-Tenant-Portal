import { describe, expect, it } from "vitest"
import { MIN_PARTIAL_SHARE, minimumPartial } from "./tenant-service"

describe("minimumPartial (25% of the balance)", () => {
    it("is 25% of the balance, rounded up to the cent", () => {
        expect(MIN_PARTIAL_SHARE).toBe(0.25)
        expect(minimumPartial(1820)).toBe(455)
        expect(minimumPartial(1250)).toBe(312.5)
        expect(minimumPartial(100.01)).toBe(25.01) // 25.0025 rounds up
        expect(minimumPartial(0.04 + 1000)).toBe(250.01)
    })

    it("is never under $1 unless the balance is, and never more than the balance", () => {
        expect(minimumPartial(3)).toBe(1)
        expect(minimumPartial(0.6)).toBe(0.6)
        expect(minimumPartial(0)).toBe(0)
        expect(minimumPartial(-50)).toBe(0)
    })
})
