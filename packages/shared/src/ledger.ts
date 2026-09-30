import type { Cents } from "./money.ts";
import type { PeriodKey, Uuid } from "./ids.ts";

/**
 * The shared ledger.
 *
 * One table, append-only, read identically by the resident and the manager. The
 * two roles differ in what they may *do* and in how the client presents the
 * rows, never in which rows exist or what they say. A correction is a new row
 * that reverses an old one; nothing is ever updated or deleted, which is
 * enforced by database triggers and by revoking UPDATE/DELETE from the
 * application role, not by convention.
 */

export const ENTRY_TYPES = [
  "charge",
  "payment",
  "credit",
  "adjustment",
  "reversal",
  "annotation",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_CATEGORIES = [
  "rent",
  "prorated_rent",
  "utility",
  "parking",
  "pet_rent",
  "late_fee",
  "nsf_fee",
  "deposit",
  "maintenance_credit",
  "concession",
  "waiver",
  "payment_ach",
  "payment_card",
  "payment_check",
  "payment_cash",
  "payment_money_order",
  "refund",
  "payment_plan",
  "other",
] as const;
export type EntryCategory = (typeof ENTRY_CATEGORIES)[number];

/**
 * An `annotation` carries no money (amount is always zero) and exists so that a
 * discretionary decision — a payment plan opened, an escalation paused after a
 * bank failure — appears in the same stream of rows the resident already reads,
 * with an actor and a reason attached. Accommodations that live in a text
 * message are exactly how a resident who was granted grace ends up with a
 * delinquency anyway; putting them in the ledger is the fix.
 */
export const ANNOTATION_CATEGORIES: readonly EntryCategory[] = ["payment_plan", "other"];

export interface LedgerEntry {
  id: Uuid;
  tenancyId: Uuid;
  propertyId: Uuid;
  entryType: EntryType;
  category: EntryCategory;
  /** Signed: positive increases what is owed, negative decreases it. */
  amountCents: Cents;
  description: string;
  /** The period this row is accounted to, e.g. the month a rent charge covers. */
  period: PeriodKey;
  /** The calendar date the row takes effect for balance and aging purposes. */
  effectiveDate: string;
  /** When the row was written. Immutable, set by the database. */
  postedAt: string;
  /** For a reversal, the row being reversed. */
  reversesEntryId: Uuid | null;
  /** Set on rows that a later reversal has cancelled. Derived, not stored. */
  reversedByEntryId: Uuid | null;
  paymentId: Uuid | null;
  workOrderId: Uuid | null;
  paymentPlanId: Uuid | null;
  /** Who caused this row. Null means the scheduled job runner posted it. */
  actorUserId: Uuid | null;
  actorName: string | null;
  actorRole: string | null;
  /** Required on every discretionary action; null on automatic postings. */
  actorReason: string | null;
  idempotencyKey: string;
}

/** The balance of any set of rows is their sum. There is no other definition. */
export function balanceOf(entries: readonly LedgerEntry[]): Cents {
  return entries.reduce((sum, e) => sum + e.amountCents, 0) as Cents;
}

export function chargesIn(entries: readonly LedgerEntry[]): Cents {
  return entries.filter((e) => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0) as Cents;
}

export function creditsIn(entries: readonly LedgerEntry[]): Cents {
  return entries.filter((e) => e.amountCents < 0).reduce((s, e) => s + e.amountCents, 0) as Cents;
}

/**
 * Rows grouped by the period they are accounted to, newest period first. This is
 * the shape the resident's ledger view and the manager's period export both
 * consume, so that "what does this month look like" has one answer.
 */
export interface PeriodSummary {
  period: PeriodKey;
  charged: Cents;
  credited: Cents;
  net: Cents;
  /** Balance carried into this period from every earlier row. */
  openingBalance: Cents;
  closingBalance: Cents;
  entries: LedgerEntry[];
}

export function summarizeByPeriod(entries: readonly LedgerEntry[]): PeriodSummary[] {
  const ordered = [...entries].sort(
    (a, b) =>
      a.period.localeCompare(b.period) ||
      a.effectiveDate.localeCompare(b.effectiveDate) ||
      a.postedAt.localeCompare(b.postedAt),
  );

  const byPeriod = new Map<PeriodKey, LedgerEntry[]>();
  for (const entry of ordered) {
    const bucket = byPeriod.get(entry.period);
    if (bucket) bucket.push(entry);
    else byPeriod.set(entry.period, [entry]);
  }

  const summaries: PeriodSummary[] = [];
  let running = 0;
  for (const [period, rows] of byPeriod) {
    const opening = running as Cents;
    const charged = chargesIn(rows);
    const credited = creditsIn(rows);
    running += charged + credited;
    summaries.push({
      period,
      charged,
      credited,
      net: (charged + credited) as Cents,
      openingBalance: opening,
      closingBalance: running as Cents,
      entries: rows,
    });
  }

  return summaries.reverse();
}

/**
 * Aging of what is currently owed, by how long each unpaid charge has been
 * outstanding. Payments are applied oldest-charge-first, which is stated to the
 * resident rather than left implicit — the alternative (applying to the newest
 * charge) silently maximizes late fees.
 */
export interface AgingBuckets {
  current: Cents;
  days1to30: Cents;
  days31to60: Cents;
  days61plus: Cents;
  total: Cents;
}

/**
 * The effective date of the oldest charge that credits have not yet covered,
 * applying credits first-in, first-out — or null when nothing is owed.
 *
 * This is what "days past due" means. The oldest charge *ever* is not: a
 * resident who has paid every month for two years and is $40 short this month
 * is a few days behind, not two years behind. The rent roll and exception queue
 * compute the same thing in SQL; a test holds the two to agreement.
 */
export function oldestUnpaidDate(entries: readonly LedgerEntry[]): string | null {
  const charges = entries
    .filter((e) => e.amountCents > 0)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.postedAt.localeCompare(b.postedAt));
  let credited = -entries.filter((e) => e.amountCents < 0).reduce((s, e) => s + e.amountCents, 0);
  for (const charge of charges) {
    if (credited < charge.amountCents) return charge.effectiveDate;
    credited -= charge.amountCents;
  }
  return null;
}

export function ageBalance(entries: readonly LedgerEntry[], asOf: string): AgingBuckets {
  const charges = entries
    .filter((e) => e.amountCents > 0)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.postedAt.localeCompare(b.postedAt))
    .map((e) => ({ date: e.effectiveDate, remaining: e.amountCents as number }));

  let creditPool = -entries.filter((e) => e.amountCents < 0).reduce((s, e) => s + e.amountCents, 0);

  for (const charge of charges) {
    if (creditPool <= 0) break;
    const applied = Math.min(creditPool, charge.remaining);
    charge.remaining -= applied;
    creditPool -= applied;
  }

  const buckets: AgingBuckets = {
    current: 0 as Cents,
    days1to30: 0 as Cents,
    days31to60: 0 as Cents,
    days61plus: 0 as Cents,
    total: 0 as Cents,
  };

  const asOfMs = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  for (const charge of charges) {
    if (charge.remaining <= 0) continue;
    const age = Math.round((asOfMs - Date.parse(`${charge.date}T00:00:00Z`)) / 86_400_000);
    const amount = charge.remaining as Cents;
    if (age <= 0) buckets.current = (buckets.current + amount) as Cents;
    else if (age <= 30) buckets.days1to30 = (buckets.days1to30 + amount) as Cents;
    else if (age <= 60) buckets.days31to60 = (buckets.days31to60 + amount) as Cents;
    else buckets.days61plus = (buckets.days61plus + amount) as Cents;
  }

  // An overpayment leaves the resident in credit; report it rather than clamping
  // to zero, because a credit the resident cannot see is a credit they will not
  // know to spend.
  const raw = entries.reduce((s, e) => s + e.amountCents, 0);
  buckets.total = (raw < 0 ? raw : buckets.current + buckets.days1to30 + buckets.days31to60 + buckets.days61plus) as Cents;
  return buckets;
}

/**
 * Plain-language explanation of a single row, used in the resident's ledger and
 * in notification bodies. A row the resident cannot explain to themselves is
 * treated as a defect in this system, so this text is part of the product and
 * not a debugging aid.
 */
export function describeEntry(entry: LedgerEntry): string {
  switch (entry.entryType) {
    case "payment":
      return `Payment received — ${entry.description}`;
    case "reversal":
      return `Reversal — ${entry.description}`;
    case "credit":
      return `Credit applied — ${entry.description}`;
    case "adjustment":
      return `Adjustment — ${entry.description}`;
    case "annotation":
      return entry.description;
    default:
      return entry.description;
  }
}
