/**
 * The manager dashboard — "your portfolio at a glance" from the Figma
 * prototype (Manager Prototype 2 → Desktop / Manager Dashboard, Mobile /
 * Manager Home).
 *
 * Nothing here is stored. The rent figures are the rent roll's own totals, so
 * the dashboard and the rent roll cannot disagree; the maintenance counts are
 * read from the same work-order rows the queue lists; and the activity feed is
 * a union of rows the caller could already read one screen away. Every query
 * runs inside the caller's Row-Level Security scope, so an owner assigned to
 * one property sees that property's numbers and nothing else without this
 * file having to know that.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { formatMoney } from "../../../../packages/shared/src/money.ts";
import type { PeriodKey } from "../../../../packages/shared/src/ids.ts";
import { periodOf, today } from "../../../../packages/shared/src/ids.ts";
import type { ActivityItem, ActivityKind, DashboardResponse } from "../../../../packages/shared/src/api.ts";
import { rentRoll, exceptions } from "./rentroll.ts";
import { unreadThreadCount } from "./messages.ts";

/** Exceptions that need a decision rather than time. */
const REVIEW_KINDS = new Set(["payment_failed", "payment_returned", "dispute_open", "plan_missed", "autopay_blocked"]);

export interface DashboardOptions {
  period?: PeriodKey;
  propertyId?: string;
  /** Whether the caller may read maintenance. Owners may not; the section is omitted rather than zeroed. */
  includeMaintenance: boolean;
  activityLimit?: number;
}

export async function dashboard(tx: Tx, options: DashboardOptions): Promise<DashboardResponse> {
  const started = Date.now();
  const period = options.period ?? periodOf(today());
  const propertyId = options.propertyId ?? null;

  const portfolio = await tx.one<{ properties: number; units: number; occupied: number }>(
    `SELECT count(*)::int AS properties,
            COALESCE(sum((SELECT count(*) FROM units u WHERE u.property_id = p.id)), 0)::int AS units,
            COALESCE(sum((SELECT count(*) FROM tenancies t
                          WHERE t.property_id = p.id AND t.status = 'active')), 0)::int AS occupied
     FROM properties p
     WHERE ($1::uuid IS NULL OR p.id = $1::uuid)`,
    [propertyId],
  );

  const roll = await rentRoll(tx, { period, propertyId: propertyId ?? undefined, limit: 1000 });
  const queue = await exceptions(tx, { period, propertyId: propertyId ?? undefined });

  const overdueAccounts = roll.rows.filter((row) => row.balanceCents > 0 && row.daysPastDue > 0).length;
  const needsReview = queue.rows.filter((row) => REVIEW_KINDS.has(row.kind)).length;

  const maintenance = options.includeMaintenance ? await maintenanceCounts(tx, period, propertyId) : null;
  const activity = await recentActivity(tx, {
    propertyId,
    includeMaintenance: options.includeMaintenance,
    limit: options.activityLimit ?? 5,
  });

  return {
    period,
    portfolio: {
      properties: portfolio.properties,
      units: portfolio.units,
      occupied: portfolio.occupied,
      vacant: Math.max(0, portfolio.units - portfolio.occupied),
    },
    rent: {
      expectedCents: roll.totals.chargedCents,
      collectedCents: roll.totals.collectedCents,
      outstandingCents: roll.totals.outstandingCents,
      collectionRate: roll.totals.collectionRate,
      overdueAccounts,
      needsReview,
    },
    maintenance,
    activity,
    // Owners have no messages (011: resident correspondence is not an owner report).
    unreadMessages: tx.context.role === "owner" ? null : await unreadThreadCount(tx),
    generatedInMs: Date.now() - started,
  };
}

async function maintenanceCounts(
  tx: Tx,
  period: PeriodKey,
  propertyId: string | null,
): Promise<NonNullable<DashboardResponse["maintenance"]>> {
  const row = await tx.one<{ open: number; high: number; in_progress: number; completed: number }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('submitted','acknowledged','scheduled','in_progress'))::int AS open,
       count(*) FILTER (WHERE status IN ('submitted','acknowledged','scheduled','in_progress')
                          AND priority = 'emergency')::int AS high,
       count(*) FILTER (WHERE status IN ('scheduled','in_progress'))::int AS in_progress,
       count(*) FILTER (WHERE status IN ('resolved','closed')
                          AND to_char(resolved_at, 'YYYY-MM') = $2)::int AS completed
     FROM work_orders
     WHERE ($1::uuid IS NULL OR property_id = $1::uuid)`,
    [propertyId, period],
  );
  return { open: row.open, highPriority: row.high, inProgress: row.in_progress, completedThisPeriod: row.completed };
}

interface ActivityRow {
  kind: ActivityKind;
  at: string;
  resident_name: string | null;
  unit_label: string;
  amount_cents: number | null;
  title: string | null;
  tenancy_id: string | null;
  work_order_id: string | null;
}

const ACTIVITY_TITLES: Record<ActivityKind, string> = {
  payment_received: "Payment received",
  payment_failed: "Payment failed",
  payment_pending: "Payment submitted",
  workorder_submitted: "New maintenance request",
  workorder_completed: "Maintenance completed",
  lease_started: "Lease started",
};

/**
 * The feed, newest first. Each branch is limited before the union so a
 * portfolio with two years of payments does not sort all of them to show five.
 */
async function recentActivity(
  tx: Tx,
  options: { propertyId: string | null; includeMaintenance: boolean; limit: number },
): Promise<ActivityItem[]> {
  const limit = Math.min(Math.max(options.limit, 1), 50);

  const maintenanceBranches = options.includeMaintenance
    ? `UNION ALL
       (SELECT 'workorder_submitted'::text, w.submitted_at, NULL, u.label, NULL::bigint, w.title, NULL::uuid, w.id
        FROM work_orders w JOIN units u ON u.id = w.unit_id
        WHERE ($1::uuid IS NULL OR w.property_id = $1::uuid)
        ORDER BY w.submitted_at DESC LIMIT $2)
       UNION ALL
       (SELECT 'workorder_completed'::text, w.resolved_at, NULL, u.label, NULL::bigint, w.title, NULL::uuid, w.id
        FROM work_orders w JOIN units u ON u.id = w.unit_id
        WHERE w.resolved_at IS NOT NULL AND w.status IN ('resolved','closed')
          AND ($1::uuid IS NULL OR w.property_id = $1::uuid)
        ORDER BY w.resolved_at DESC LIMIT $2)`
    : "";

  const rows = await tx.many<ActivityRow>(
    `SELECT kind, at::text AS at, resident_name, unit_label, amount_cents, title, tenancy_id, work_order_id
     FROM (
       (SELECT CASE
                 WHEN p.status = 'settled' THEN 'payment_received'
                 WHEN p.status IN ('failed','returned') THEN 'payment_failed'
                 ELSE 'payment_pending'
               END::text AS kind,
               COALESCE(p.resolved_at, p.settled_at, p.submitted_at) AS at,
               usr.display_name AS resident_name, u.label AS unit_label,
               p.amount_cents, NULL::text AS title, p.tenancy_id, NULL::uuid AS work_order_id
        FROM payments p
        JOIN tenancies t ON t.id = p.tenancy_id
        JOIN units u ON u.id = t.unit_id
        JOIN users usr ON usr.id = t.resident_user_id
        WHERE p.status IN ('settled','failed','returned','pending','processing')
          AND ($1::uuid IS NULL OR p.property_id = $1::uuid)
        ORDER BY COALESCE(p.resolved_at, p.settled_at, p.submitted_at) DESC
        LIMIT $2)
       UNION ALL
       (SELECT 'lease_started'::text, t.starts_on::timestamptz, usr.display_name, u.label,
               NULL::bigint, NULL::text, t.id, NULL::uuid
        FROM tenancies t
        JOIN units u ON u.id = t.unit_id
        JOIN users usr ON usr.id = t.resident_user_id
        WHERE t.starts_on <= current_date
          AND ($1::uuid IS NULL OR t.property_id = $1::uuid)
        ORDER BY t.starts_on DESC LIMIT $2)
       ${maintenanceBranches}
     ) feed
     WHERE at IS NOT NULL AND at <= now()
     ORDER BY at DESC
     LIMIT $2`,
    [options.propertyId, limit],
  );

  return rows.map((row) => {
    const parts: string[] = [];
    if (row.resident_name) parts.push(row.resident_name);
    parts.push(`Unit ${row.unit_label}`);
    if (row.title) parts.push(row.title);
    if (row.amount_cents !== null) parts.push(formatMoney(Number(row.amount_cents) as Cents));
    return {
      kind: row.kind,
      title: ACTIVITY_TITLES[row.kind],
      detail: parts.join(" · "),
      at: row.at,
      tenancyId: row.tenancy_id,
      workOrderId: row.work_order_id,
    };
  });
}
