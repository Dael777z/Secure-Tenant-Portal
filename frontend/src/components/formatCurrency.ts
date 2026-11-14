export function formatCurrency(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A running balance: a negative one is money paid ahead, shown as credit. */
export function formatBalance(balance: number): string {
  return balance < 0 ? `${formatCurrency(-balance)} credit` : formatCurrency(balance);
}
