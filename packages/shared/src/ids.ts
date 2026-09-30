/** Identifier and calendar helpers shared by the API, the jobs, and the client. */

export type Uuid = string;

/** `YYYY-MM`, the accounting period a rent roll is opened for. */
export type PeriodKey = string;

export function periodOf(date: Date | string): PeriodKey {
  const d = typeof date === "string" ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodStart(period: PeriodKey): string {
  return `${period}-01`;
}

export function periodEnd(period: PeriodKey): string {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function shiftPeriod(period: PeriodKey, months: number): PeriodKey {
  const [y, m] = period.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function comparePeriods(a: PeriodKey, b: PeriodKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The day a charge falls due within a period, clamped to the length of that
 * month. A lease that says "due on the 31st" is due on the 30th in April; the
 * alternative — silently rolling into May — creates a phantom late fee.
 */
export function dueDateFor(period: PeriodKey, dayOfMonth: number): string {
  const [y, m] = period.split("-").map(Number);
  const day = Math.min(Math.max(dayOfMonth, 1), daysInMonth(y, m));
  return `${period}-${String(day).padStart(2, "0")}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * The portal's business time zone. Rent is due on a calendar date where the
 * property is, not in UTC: at 7pm in Las Cruces it is already tomorrow in UTC,
 * and a payment plan whose first installment is "today" was being refused as
 * "in the past". The server sets this once at start-up (PORTAL_TIMEZONE);
 * anything that never sets it — the test suites — keeps UTC.
 */
let portalTimeZone = "UTC";

export function setPortalTimeZone(zone: string): void {
  // Throws RangeError for an unknown zone, which is what start-up should do.
  new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
  portalTimeZone = zone;
}

export function getPortalTimeZone(): string {
  return portalTimeZone;
}

export function today(now: Date = new Date()): string {
  if (portalTimeZone === "UTC") return now.toISOString().slice(0, 10);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: portalTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
