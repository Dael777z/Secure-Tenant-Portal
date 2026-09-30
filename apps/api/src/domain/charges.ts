/**
 * The charge scheduler.
 *
 * Posts the recurring charges for an accounting period. Runs from the job runner
 * on the first of the month and can be run by a manager on demand, which is the
 * same code path — a manager pressing "post September" and the clock reaching
 * September must produce identical rows, or the two copies of the record are
 * back.
 *
 * Idempotency is structural rather than defensive: the key for a rent charge is
 * `rent:<tenancy>:<period>`, so posting September twice produces one September
 * charge. This matters more than it sounds. The alternative — a guard that
 * checks whether the job already ran — fails exactly when it is needed, during
 * the partial run that crashed halfway through.
 */

import type { Tx } from "../db/context.ts";
import type { PeriodKey } from "../../../../packages/shared/src/ids.ts";
import { daysInMonth, dueDateFor, periodEnd, periodStart } from "../../../../packages/shared/src/ids.ts";
import { prorate } from "../../../../packages/shared/src/money.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type { EntryCategory } from "../../../../packages/shared/src/ledger.ts";
import { postEntry } from "./ledger.ts";

export interface PlannedCharge {
  tenancyId: string;
  unitLabel: string;
  residentName: string;
  category: EntryCategory;
  amountCents: Cents;
  description: string;
  effectiveDate: string;
  idempotencyKey: string;
  alreadyPosted: boolean;
}

interface ScheduleRow {
  tenancy_id: string;
  property_id: string;
  unit_label: string;
  resident_name: string;
  monthly_rent_cents: number;
  rent_due_day: number;
  starts_on: string;
  ends_on: string | null;
  status: string;
}

/**
 * Work out what a period *should* contain, without writing anything.
 *
 * Separating the plan from the posting is what makes a dry run meaningful: the
 * preview a manager approves is computed by the same function that then posts,
 * so it cannot show one thing and do another.
 */
export async function planPeriod(
  tx: Tx,
  period: PeriodKey,
  propertyId?: string,
): Promise<PlannedCharge[]> {
  const [year, month] = period.split("-").map(Number);
  const lengthOfMonth = daysInMonth(year, month);
  const start = periodStart(period);
  const end = periodEnd(period);

  const tenancies = await tx.many<ScheduleRow>(
    `SELECT t.id AS tenancy_id, t.property_id, u.label AS unit_label,
            usr.display_name AS resident_name, t.monthly_rent_cents, t.rent_due_day,
            t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, t.status
     FROM tenancies t
     JOIN units u ON u.id = t.unit_id
     JOIN users usr ON usr.id = t.resident_user_id
     WHERE t.status IN ('active','pending')
       AND ($1::uuid IS NULL OR t.property_id = $1::uuid)
       AND t.starts_on <= $3::date
       AND (t.ends_on IS NULL OR t.ends_on >= $2::date)
     ORDER BY u.label`,
    [propertyId ?? null, start, end],
  );

  const planned: PlannedCharge[] = [];

  for (const tenancy of tenancies) {
    const dueDate = dueDateFor(period, tenancy.rent_due_day);

    // Proration on the way in and on the way out. A resident who moves in on the
    // 20th of a 31-day month pays 12/31 of the rent, computed against that
    // month's real length rather than a 30-day convention — the difference is
    // small, unexplained, and exactly the kind of number that erodes trust.
    const movesInMidPeriod = tenancy.starts_on > start && tenancy.starts_on <= end;
    const movesOutMidPeriod = tenancy.ends_on !== null && tenancy.ends_on >= start && tenancy.ends_on < end;

    if (movesInMidPeriod || movesOutMidPeriod) {
      const firstDay = movesInMidPeriod ? Number(tenancy.starts_on.slice(8, 10)) : 1;
      const lastDay = movesOutMidPeriod ? Number(tenancy.ends_on!.slice(8, 10)) : lengthOfMonth;
      const occupied = Math.max(0, lastDay - firstDay + 1);
      if (occupied === 0) continue;

      const amount = prorate(tenancy.monthly_rent_cents as Cents, occupied, lengthOfMonth);
      planned.push({
        tenancyId: tenancy.tenancy_id,
        unitLabel: tenancy.unit_label,
        residentName: tenancy.resident_name,
        category: "prorated_rent",
        amountCents: amount,
        description:
          `Prorated rent, ${occupied} of ${lengthOfMonth} days ` +
          `(${period}-${String(firstDay).padStart(2, "0")} to ${period}-${String(lastDay).padStart(2, "0")})`,
        effectiveDate: movesInMidPeriod ? tenancy.starts_on : dueDate,
        idempotencyKey: `prorated_rent:${tenancy.tenancy_id}:${period}`,
        alreadyPosted: false,
      });
    } else {
      planned.push({
        tenancyId: tenancy.tenancy_id,
        unitLabel: tenancy.unit_label,
        residentName: tenancy.resident_name,
        category: "rent",
        amountCents: tenancy.monthly_rent_cents as Cents,
        description: `Rent for ${monthName(year, month)}`,
        effectiveDate: dueDate,
        idempotencyKey: `rent:${tenancy.tenancy_id}:${period}`,
        alreadyPosted: false,
      });
    }
  }

  // Everything else the lease says recurs: parking, pet rent, a utility split.
  const extras = await tx.many<{
    id: string;
    tenancy_id: string;
    unit_label: string;
    resident_name: string;
    category: string;
    amount_cents: number;
    description: string;
    day_of_month: number;
  }>(
    `SELECT rc.id, rc.tenancy_id, u.label AS unit_label, usr.display_name AS resident_name,
            rc.category, rc.amount_cents, rc.description, rc.day_of_month
     FROM recurring_charges rc
     JOIN tenancies t ON t.id = rc.tenancy_id
     JOIN units u ON u.id = t.unit_id
     JOIN users usr ON usr.id = t.resident_user_id
     WHERE rc.active
       AND t.status = 'active'
       AND ($1::uuid IS NULL OR rc.property_id = $1::uuid)
       AND rc.starts_on <= $3::date
       AND (rc.ends_on IS NULL OR rc.ends_on >= $2::date)
     ORDER BY u.label, rc.category`,
    [propertyId ?? null, start, end],
  );

  for (const extra of extras) {
    planned.push({
      tenancyId: extra.tenancy_id,
      unitLabel: extra.unit_label,
      residentName: extra.resident_name,
      category: extra.category as EntryCategory,
      amountCents: extra.amount_cents as Cents,
      description: extra.description,
      effectiveDate: dueDateFor(period, extra.day_of_month),
      idempotencyKey: `recurring:${extra.id}:${period}`,
      alreadyPosted: false,
    });
  }

  // Mark what is already in the ledger so the preview distinguishes "will post"
  // from "posted last time you ran this".
  if (planned.length > 0) {
    const existing = await tx.many<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM ledger_entries WHERE idempotency_key = ANY($1::text[])",
      [planned.map((p) => p.idempotencyKey)],
    );
    const posted = new Set(existing.map((e) => e.idempotency_key));
    for (const charge of planned) charge.alreadyPosted = posted.has(charge.idempotencyKey);
  }

  return planned;
}

export interface PostPeriodResult {
  planned: PlannedCharge[];
  posted: number;
  skipped: number;
  totalCents: Cents;
}

export async function postPeriod(
  tx: Tx,
  period: PeriodKey,
  options: { propertyId?: string; dryRun: boolean; actorUserId?: string | null; actorRole: string },
): Promise<PostPeriodResult> {
  const planned = await planPeriod(tx, period, options.propertyId);
  const pending = planned.filter((p) => !p.alreadyPosted);

  if (!options.dryRun) {
    for (const charge of pending) {
      await postEntry(tx, {
        tenancyId: charge.tenancyId,
        entryType: "charge",
        category: charge.category,
        amountCents: charge.amountCents,
        description: charge.description,
        period,
        effectiveDate: charge.effectiveDate,
        actorUserId: options.actorUserId ?? null,
        actorRole: options.actorRole,
        idempotencyKey: charge.idempotencyKey,
      });
    }
  }

  return {
    planned,
    posted: options.dryRun ? 0 : pending.length,
    skipped: planned.length - pending.length,
    totalCents: pending.reduce((sum, p) => sum + p.amountCents, 0) as Cents,
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function describePeriod(period: PeriodKey): string {
  const [year, month] = period.split("-").map(Number);
  return monthName(year, month);
}
