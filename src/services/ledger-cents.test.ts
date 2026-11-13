import { describe, expect, it } from "vitest"

import type { ChargeRecord, PaymentRecord } from "../types/records"
import { buildLedger } from "./ledger"

// Money is stored in dollars with two decimals; the ledger adds it up in whole cents so floating-point
// dust (19.99 * 100 = 1998.9999999999998) never changes a balance.
const charge = (id: number, amount: number): ChargeRecord => ({ id, leaseId: 1, kind: "other", amount, dueDate: "2026-10-01", description: null })
const payment = (id: number, amount: number, direction: "charge" | "refund" = "charge"): PaymentRecord =>
    ({ id, leaseId: 1, direction, status: "completed", amount, paidAt: new Date("2026-10-05T12:00:00Z"), method: "Check", confirmation: `C-${id}`, payerId: null })

describe("ledger balance in cents", () => {
    it("adds awkward amounts exactly", () => {
        expect(buildLedger([charge(1, 19.99)], []).balance).toBe(19.99)
        expect(buildLedger([charge(1, 10.1), charge(2, 20.2)], []).balance).toBe(30.3)
        expect(buildLedger([charge(1, 1450.07), charge(2, 0.29)], [payment(1, 0.29)]).balance).toBe(1450.07)
    })

    it("a payment of exactly what is owed brings the balance to zero, whatever the cents", () => {
        for (const amount of [0.07, 19.99, 33.33, 1234.56, 1450.07, 99999.99]) {
            expect(buildLedger([charge(1, amount)], [payment(1, amount)]).balance, String(amount)).toBe(0)
        }
    })

    it("a refund puts the money back on the balance", () => {
        expect(buildLedger([charge(1, 19.99)], [payment(1, 19.99), payment(2, 19.99, "refund")]).balance).toBe(19.99)
    })

    it("many mixed amounts add up to the whole-cent total (repeatable pseudo-random data)", () => {
        let seed = 12345
        const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
        const charges: ChargeRecord[] = []
        const payments: PaymentRecord[] = []
        let expectedCents = 0
        for (let i = 1; i <= 300; i++) {
            const c = (next() % 200_000) + 1
            charges.push(charge(i, c / 100))
            expectedCents += c
            if (i % 3 === 0) {
                const p = (next() % c) + 1
                payments.push(payment(i, p / 100))
                expectedCents -= p
            }
        }
        expect(buildLedger(charges, payments).balance).toBe(expectedCents / 100)
    })
})
