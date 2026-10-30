// The processing fee, worked out the way the server does (src/services/fees.ts) so the
// pay page can show it before paying. The server's figure is the one Cash App charges.

export interface FeeRate {
  /** 290 = 2.9% */
  basisPoints: number;
  fixedCents: number;
}

/** The fee on `amount` dollars: enough that, after the processor's cut, the full amount reaches the office. */
export function processingFee(amount: number, rate: FeeRate): number {
  const amountCents = Math.round(amount * 100);
  const totalCents = Math.ceil(((amountCents + rate.fixedCents) * 10_000) / (10_000 - rate.basisPoints));
  return (totalCents - amountCents) / 100;
}

/** "2.9% + $0.30" */
export function describeRate(rate: FeeRate): string {
  return `${rate.basisPoints / 100}% + $${(rate.fixedCents / 100).toFixed(2)}`;
}
