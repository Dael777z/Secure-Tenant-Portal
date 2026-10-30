/**
 * Processing fees passed on to the tenant (007). Stripe takes its percentage from the
 * whole amount charged, fee included, so adding "2.9% + 30¢ of the rent" would still
 * leave the office short. Instead the total is grossed up: the smallest amount that,
 * after Stripe's fee, still leaves the full rent.
 *
 *   total = ceil((rent + fixed) / (1 - rate))      fee = total - rent
 *
 * All in whole cents, with the rate in basis points (2.9% = 290), so there is no
 * floating-point rounding. The browser repeats this to show the fee before paying
 * (frontend/src/components/fees.ts); the server's figure is the one charged.
 */
export interface FeeRate {
    /** 290 = 2.9% */
    basisPoints: number
    fixedCents: number
}

/** Stripe's Cash App Pay pricing (US): 2.9% + 30¢. */
export const CASH_APP_FEE: FeeRate = { basisPoints: 290, fixedCents: 30 }

export function feeFor(amountCents: number, rate: FeeRate): { feeCents: number; totalCents: number } {
    const totalCents = Math.ceil(((amountCents + rate.fixedCents) * 10_000) / (10_000 - rate.basisPoints))
    return { feeCents: totalCents - amountCents, totalCents }
}
