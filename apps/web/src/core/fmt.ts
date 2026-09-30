/**
 * Formatting.
 *
 * The money helpers re-export from the shared package rather than
 * reimplementing, so that a figure rendered in the browser and the same figure
 * written into an accountant's CSV are produced by one function.
 *
 * The date helpers exist because a rent ledger is one of the few places where
 * getting a timezone wrong changes a fact: a payment posted at 11pm on the 30th
 * is not a payment posted on the 1st, and if the difference decides a late fee,
 * "close enough" is somebody's $50.
 */

import { formatMoney, type Cents } from "/shared/money.js";

export { formatMoney };

export const money = (value: number): string => formatMoney(value as Cents);

/** With an explicit sign, for a ledger column where direction is the point. */
export const signedMoney = (value: number): string =>
  value === 0 ? formatMoney(0 as Cents) : formatMoney(value as Cents, { showSign: true });

export function moneyClass(value: number): string {
  if (value > 0) return "money money--owed";
  if (value < 0) return "money money--credit";
  return "money money--zero";
}

/** Dollars as typed by a person ("1,250.00", "$40", "40.5") into whole cents. */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format a calendar date without ever constructing a Date from it.
 *
 * `new Date("2026-09-01")` parses as UTC midnight and then renders in local
 * time, which in the Americas prints "August 31". On a rent ledger that is not
 * a cosmetic bug — it is the difference between on time and late.
 */
export function date(iso: string | null | undefined, style: "long" | "short" | "numeric" = "long"): string {
  if (!iso) return "—";
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "—";
  if (style === "numeric") return `${month}/${day}/${year}`;
  if (style === "short") return `${SHORT_MONTHS[month - 1]} ${day}`;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * Parse a timestamp as PostgreSQL's ::text renders it ("2026-09-25
 * 22:33:29.33+00"). V8 rejects a bare "+00" offset once the space becomes a
 * "T", so the offset is widened to "+00:00" first. Returns NaN if unparseable.
 */
export function parseTimestamp(iso: string): number {
  // Only an offset that follows a clock time: "2026-09-25" must not become "2026-09-25:00".
  const normalized = iso.trim().replace(" ", "T").replace(/(T[\d:.]+[+-]\d{2})$/, "$1:00");
  return Date.parse(normalized);
}

/** A timestamp, which unlike a calendar date genuinely has a moment attached. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(parseTimestamp(iso));
  if (Number.isNaN(parsed.getTime())) return date(iso);
  // The reader's own calendar day, to match the reader's own clock time below.
  // (toISOString() is the UTC day, which is already tomorrow on a US evening.)
  const localDay = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  return `${date(localDay)} at ${parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function period(key: string | null | undefined): string {
  if (!key) return "—";
  const [year, month] = key.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

export function shortPeriod(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return `${SHORT_MONTHS[month - 1]} ${String(year).slice(2)}`;
}

/** "in 3 days", "9 days ago", "today" — computed on calendar days, not hours. */
export function relativeDays(iso: string | null | undefined, from = todayIso()): string {
  if (!iso) return "";
  const days = Math.round(
    (Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

export function todayIso(): string {
  const now = new Date();
  // The local calendar date, not the UTC one: a resident in Las Cruces looking
  // at this at 7pm should see today's date, not tomorrow's.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function currentPeriod(): string {
  return todayIso().slice(0, 7);
}

export function addMonths(periodKey: string, months: number): string {
  const [year, month] = periodKey.split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Human labels for ledger categories. The resident reads these words. */
export const CATEGORY_LABELS: Record<string, string> = {
  rent: "Rent",
  prorated_rent: "Prorated rent",
  utility: "Utilities",
  parking: "Parking",
  pet_rent: "Pet rent",
  late_fee: "Late fee",
  nsf_fee: "Returned payment fee",
  deposit: "Security deposit",
  maintenance_credit: "Maintenance credit",
  concession: "Concession",
  waiver: "Fee waived",
  payment_ach: "Bank payment",
  payment_card: "Card payment",
  payment_check: "Check",
  payment_cash: "Cash",
  payment_money_order: "Money order",
  refund: "Refund",
  payment_plan: "Payment plan",
  other: "Other",
};

export const categoryLabel = (category: string): string => CATEGORY_LABELS[category] ?? titleCase(category);

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Submitted",
  processing: "Processing",
  settled: "Received",
  failed: "Did not go through",
  returned: "Returned by bank",
  refunded: "Refunded",
  disputed: "Under dispute",
};

export function paymentStatusTone(status: string): "good" | "warn" | "bad" | "info" | "neutral" {
  switch (status) {
    case "settled":
      return "good";
    case "processing":
    case "pending":
      return "info";
    case "failed":
    case "returned":
      return "bad";
    case "disputed":
      return "warn";
    default:
      return "neutral";
  }
}

export const WORK_ORDER_STATUS_LABELS: Record<string, string> = {
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  scheduled: "Scheduled",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function workOrderTone(status: string): "good" | "warn" | "bad" | "info" | "neutral" {
  if (status === "resolved" || status === "closed") return "good";
  if (status === "in_progress" || status === "scheduled") return "info";
  if (status === "submitted") return "warn";
  return "neutral";
}

/* ------------------------------------------------------------------ *
 * Manager workspace (Figma prototype) formats
 * ------------------------------------------------------------------ */

/**
 * "$1,500" for a whole-dollar amount, "$409.50" otherwise. The prototype shows
 * rent without cents; a balance that has cents keeps them, because rounding a
 * figure someone owes is not a formatting decision.
 */
export function compactMoney(value: number): string {
  const formatted = formatMoney(value as Cents);
  return formatted.endsWith(".00") ? formatted.slice(0, -3) : formatted;
}

/** Headline KPI figures ("$178,420"), rounded to the dollar. Never used for a single account. */
export function wholeMoney(value: number): string {
  return compactMoney(Math.round(value / 100) * 100);
}

/** "Sep 1 – Sep 30, 2026" for a period key. */
export function periodRange(key: string): string {
  const [year, month] = key.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const name = SHORT_MONTHS[month - 1];
  return `${name} 1 – ${name} ${last}, ${year}`;
}

/** "2 min ago", "3 hours ago", "4 days ago", then a date. For activity feeds only. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const parsed = parseTimestamp(iso);
  if (Number.isNaN(parsed)) return date(iso, "short");
  const minutes = Math.max(0, Math.round((now - parsed) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date(new Date(parsed).toISOString(), "short");
}

/** A greeting for the local hour, as on the prototype's mobile home. */
export function greeting(hour = new Date().getHours()): string {
  if (hour < 12) return "Good morning,";
  if (hour < 18) return "Good afternoon,";
  return "Good evening,";
}
