import { describe, expect, it } from "vitest"

import { CASH_APP_FEE, feeFor } from "./fees"

/** What Stripe keeps from a charge: 2.9% (rounded to the cent) + 30¢. */
const stripeKeeps = (totalCents: number) => Math.round(totalCents * 0.029) + 30

describe("Cash App Pay processing fee", () => {
    it("is grossed up, so the office still receives the full rent after Stripe's cut", () => {
        expect(feeFor(95000, CASH_APP_FEE)).toEqual({ feeCents: 2869, totalCents: 97869 })
        for (const rent of [100, 999, 25000, 95000, 123456, 10_000_000]) {
            const { totalCents } = feeFor(rent, CASH_APP_FEE)
            const net = totalCents - stripeKeeps(totalCents)
            expect(net).toBeGreaterThanOrEqual(rent)
            expect(net - rent).toBeLessThanOrEqual(1)   // and by no more than a cent
        }
    })

    it("works in whole cents", () => {
        const { feeCents, totalCents } = feeFor(25000, CASH_APP_FEE)
        expect(Number.isInteger(feeCents) && Number.isInteger(totalCents)).toBe(true)
        expect(feeCents).toBe(778)   // $250 rent → $257.78
    })
})
