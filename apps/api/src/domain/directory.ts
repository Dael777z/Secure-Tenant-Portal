/**
 * The Units and Tenants directories from the prototype's sidebar.
 *
 * Both are read-only views over rows the caller can already reach under RLS.
 * Balances come from the ledger (sum of entries), never from a stored column,
 * for the same reason the rent roll does it that way.
 */

import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type { TenantRow, UnitRow } from "../../../../packages/shared/src/api.ts";

export async function listUnits(
  tx: Tx,
  options: { propertyId?: string; occupancy?: "all" | "occupied" | "vacant" } = {},
): Promise<UnitRow[]> {
  const rows = await tx.many<{
    unit_id: string;
    property_id: string;
    property_name: string;
    label: string;
    bedrooms: number | null;
    market_rent_cents: number;
    tenancy_id: string | null;
    resident_name: string | null;
    starts_on: string | null;
    ends_on: string | null;
    monthly_rent_cents: number | null;
    balance_cents: number | null;
    open_work_orders: number;
  }>(
    `SELECT u.id AS unit_id, u.property_id, p.name AS property_name, u.label, u.bedrooms,
            u.market_rent_cents::bigint AS market_rent_cents,
            t.id AS tenancy_id, usr.display_name AS resident_name,
            t.starts_on::text AS starts_on, t.ends_on::text AS ends_on,
            t.monthly_rent_cents::bigint AS monthly_rent_cents,
            (SELECT sum(e.amount_cents) FROM ledger_entries e WHERE e.tenancy_id = t.id)::bigint AS balance_cents,
            (SELECT count(*) FROM work_orders w
              WHERE w.unit_id = u.id AND w.status IN ('submitted','acknowledged','scheduled','in_progress'))::int
              AS open_work_orders
     FROM units u
     JOIN properties p ON p.id = u.property_id
     LEFT JOIN tenancies t ON t.unit_id = u.id AND t.status = 'active'
     LEFT JOIN users usr ON usr.id = t.resident_user_id
     WHERE ($1::uuid IS NULL OR u.property_id = $1::uuid)
       AND ($2::text = 'all'
            OR ($2::text = 'occupied' AND t.id IS NOT NULL)
            OR ($2::text = 'vacant' AND t.id IS NULL))
     ORDER BY p.name, u.label`,
    [options.propertyId ?? null, options.occupancy ?? "all"],
  );

  return rows.map((row) => ({
    unitId: row.unit_id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    label: row.label,
    bedrooms: row.bedrooms,
    marketRentCents: Number(row.market_rent_cents) as Cents,
    occupied: row.tenancy_id !== null,
    tenancyId: row.tenancy_id,
    residentName: row.resident_name,
    leaseStart: row.starts_on,
    leaseEnd: row.ends_on,
    leaseRentCents: row.monthly_rent_cents === null ? null : (Number(row.monthly_rent_cents) as Cents),
    balanceCents: row.balance_cents === null ? (row.tenancy_id ? (0 as Cents) : null) : (Number(row.balance_cents) as Cents),
    openWorkOrders: row.open_work_orders,
  }));
}

export async function listTenants(
  tx: Tx,
  options: { propertyId?: string; status?: "active" | "all"; search?: string } = {},
): Promise<TenantRow[]> {
  const rows = await tx.many<{
    tenancy_id: string;
    user_id: string;
    name: string;
    email: string;
    phone: string | null;
    property_name: string;
    unit_label: string;
    status: string;
    starts_on: string;
    ends_on: string | null;
    monthly_rent_cents: number;
    balance_cents: number | null;
    autopay: boolean;
    last_login_at: string | null;
  }>(
    `SELECT t.id AS tenancy_id, usr.id AS user_id, usr.display_name AS name, usr.email, usr.phone,
            p.name AS property_name, u.label AS unit_label, t.status,
            t.starts_on::text AS starts_on, t.ends_on::text AS ends_on,
            t.monthly_rent_cents::bigint AS monthly_rent_cents,
            (SELECT sum(e.amount_cents) FROM ledger_entries e WHERE e.tenancy_id = t.id)::bigint AS balance_cents,
            EXISTS (SELECT 1 FROM autopay_enrollments a WHERE a.tenancy_id = t.id AND a.active) AS autopay,
            usr.last_login_at::text AS last_login_at
     FROM tenancies t
     JOIN users usr ON usr.id = t.resident_user_id
     JOIN units u ON u.id = t.unit_id
     JOIN properties p ON p.id = t.property_id
     WHERE ($1::uuid IS NULL OR t.property_id = $1::uuid)
       AND ($2::text = 'all' OR t.status = 'active')
       AND ($3::text IS NULL OR usr.display_name ILIKE '%' || $3 || '%' OR usr.email ILIKE '%' || $3 || '%'
            OR u.label ILIKE '%' || $3 || '%')
     ORDER BY usr.display_name`,
    [options.propertyId ?? null, options.status ?? "active", options.search ?? null],
  );

  return rows.map((row) => ({
    tenancyId: row.tenancy_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    propertyName: row.property_name,
    unitLabel: row.unit_label,
    status: row.status,
    leaseStart: row.starts_on,
    leaseEnd: row.ends_on,
    monthlyRentCents: Number(row.monthly_rent_cents) as Cents,
    balanceCents: Number(row.balance_cents ?? 0) as Cents,
    autopay: row.autopay,
    lastSignIn: row.last_login_at,
  }));
}
