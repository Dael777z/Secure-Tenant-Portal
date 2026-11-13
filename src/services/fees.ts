/**
 * Processing fees passed on to the tenant (010). Stripe takes its percentage from the
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

/**
 * Cards, Apple Pay and Google Pay: Stripe's US card pricing, 2.9% + 30¢, passed on to the
 * tenant on every card, debit and prepaid included (the owner's decision, 11/2026). Null
 * would mean no fee (the office absorbs it); the pay page and the ledger follow this value.
 *
 * Note: Visa and Mastercard rules forbid surcharging debit and prepaid cards, and a
 * credit-card surcharge needs registering with the card networks and is banned in some
 * states. International cards cost Stripe a further 1.5%, which this flat rate does not cover.
 */
export const CARD_FEE: FeeRate | null = { basisPoints: 290, fixedCents: 30 }

export function feeFor(amountCents: number, rate: FeeRate): { feeCents: number; totalCents: number } {
    const totalCents = Math.ceil(((amountCents + rate.fixedCents) * 10_000) / (10_000 - rate.basisPoints))
    return { feeCents: totalCents - amountCents, totalCents }
}
