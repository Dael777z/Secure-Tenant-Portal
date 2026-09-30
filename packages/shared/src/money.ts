/**
 * Money in this system is an integer count of cents. It is never a float, never
 * a string in transit, and never a database `numeric` read into a JS number by
 * accident. `Cents` is a branded type so that a raw `number` cannot be passed
 * where an amount is expected without going through one of the constructors
 * below — client and server import this same module, which is what the proposal
 * means by "client and server cannot disagree about a money field."
 *
 * Sign convention, used everywhere without exception:
 *
 *   positive  = increases what the resident owes   (rent, utilities, fees)
 *   negative  = decreases what the resident owes   (payments, credits, waivers)
 *
 * A tenancy's balance is therefore the plain sum of its ledger rows. There is no
 * separate "balance" column to drift out of agreement with the entries.
 */

declare const CENTS: unique symbol;
export type Cents = number & { readonly [CENTS]: true };

export const ZERO = 0 as Cents;

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`money must be a whole number of cents, received ${value}`);
  }
  return value as Cents;
}

/** Parse a decimal string of dollars ("1,250.00", "$1250", "-40.5") into cents. */
export function parseDollars(input: string): Cents {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new RangeError(`not a currency amount: ${input}`);
  }
  const negative = cleaned.startsWith("-");
  const [whole, fraction = ""] = cleaned.replace("-", "").split(".");
  const total = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents(negative ? -total : total);
}

export const add = (...values: Cents[]): Cents => cents(values.reduce((a, b) => a + b, 0));
export const negate = (value: Cents): Cents => cents(-value);
export const abs = (value: Cents): Cents => cents(Math.abs(value));
export const max = (a: Cents, b: Cents): Cents => (a >= b ? a : b);
export const min = (a: Cents, b: Cents): Cents => (a <= b ? a : b);
export const isZero = (value: Cents): boolean => value === 0;
export const isPositive = (value: Cents): boolean => value > 0;

/**
 * Percentage of an amount, rounded half-up on the absolute value so that the
 * rounding of a fee does not depend on its sign. Used for percentage-based late
 * fees, which are a policy a manager may configure.
 */
export function percentOf(value: Cents, percent: number): Cents {
  if (!Number.isFinite(percent) || percent < 0) throw new RangeError(`bad percent: ${percent}`);
  const raw = (Math.abs(value) * percent) / 100;
  const rounded = Math.round(raw + Number.EPSILON);
  return cents(value < 0 ? -rounded : rounded);
}

/**
 * Split an amount into `parts` whole-cent pieces that sum exactly to the
 * original. The remainder cents go to the earliest parts, which is the
 * convention a resident expects from a payment plan: the first installment
 * absorbs the odd cent rather than a mystery cent appearing at the end.
 */
export function splitEvenly(value: Cents, parts: number): Cents[] {
  if (!Number.isSafeInteger(parts) || parts < 1) throw new RangeError(`bad split count: ${parts}`);
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const base = Math.floor(magnitude / parts);
  let remainder = magnitude - base * parts;
  const out: Cents[] = [];
  for (let i = 0; i < parts; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out.push(cents(sign * (base + extra)));
  }
  return out;
}

/**
 * Prorated rent for a partial month, by the daily rate of that specific month —
 * not a 30-day convention. A resident who moves in on the 20th of a 31-day
 * month and is charged a 30-day daily rate is overcharged, and the difference is
 * exactly the kind of small unexplained number this project exists to eliminate.
 */
export function prorate(monthlyRent: Cents, daysOccupied: number, daysInMonth: number): Cents {
  if (!Number.isSafeInteger(daysInMonth) || daysInMonth < 28 || daysInMonth > 31) {
    throw new RangeError(`bad month length: ${daysInMonth}`);
  }
  if (!Number.isSafeInteger(daysOccupied) || daysOccupied < 0 || daysOccupied > daysInMonth) {
    throw new RangeError(`bad occupied day count: ${daysOccupied}`);
  }
  if (daysOccupied === daysInMonth) return monthlyRent;
  const raw = (Math.abs(monthlyRent) * daysOccupied) / daysInMonth;
  const rounded = Math.round(raw + Number.EPSILON);
  return cents(monthlyRent < 0 ? -rounded : rounded);
}

/** "$1,250.00" — the form shown to residents. Always signed explicitly if negative. */
export function formatMoney(value: Cents, options: { showSign?: boolean } = {}): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / 100).toLocaleString("en-US");
  const fraction = String(magnitude % 100).padStart(2, "0");
  const body = `$${whole}.${fraction}`;
  if (negative) return `-${body}`;
  return options.showSign ? `+${body}` : body;
}

/** "1250.00" — the form written into a CSV export for an accountant. */
export function formatDecimal(value: Cents): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}
