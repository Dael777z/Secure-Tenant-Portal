/**
 * Period exports.
 *
 * Three audiences, three shapes. An accountant wants every row with its
 * accounting attributes; an owner wants the position without the residents'
 * personal details; a legal export wants one tenancy's complete, ordered history
 * with the actor and reason on every discretionary line, because that is what a
 * proceeding actually turns on.
 *
 * All three are generated from the ledger itself rather than from a report
 * table. An export that disagrees with the resident's screen is the two-copies
 * problem wearing a different hat.
 */

import type { Tx } from "../db/context.ts";
import { formatDecimal } from "../../../../packages/shared/src/money.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import { today, type PeriodKey } from "../../../../packages/shared/src/ids.ts";
import { describePeriod } from "./charges.ts";

export type ExportAudience = "accountant" | "owner" | "legal";

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
}

interface ExportRow {
  posted_at: string;
  effective_date: string;
  period: string;
  unit_label: string;
  resident_name: string;
  entry_type: string;
  category: string;
  description: string;
  amount_cents: number;
  actor_name: string | null;
  actor_role: string | null;
  actor_reason: string | null;
  reverses_entry_id: string | null;
  receipt_number: string | null;
  entry_id: string;
}

export async function exportPeriod(
  tx: Tx,
  options: { period: PeriodKey; propertyId?: string; audience: ExportAudience; format: "csv" | "json" },
): Promise<ExportResult> {
  const rows = await tx.many<ExportRow>(
    `SELECT
       e.id AS entry_id,
       e.posted_at::text AS posted_at,
       e.effective_date::text AS effective_date,
       e.period,
       u.label AS unit_label,
       usr.display_name AS resident_name,
       e.entry_type, e.category, e.description, e.amount_cents,
       actor.display_name AS actor_name, e.actor_role, e.actor_reason,
       e.reverses_entry_id,
       p.receipt_number
     FROM ledger_entries e
     JOIN tenancies t ON t.id = e.tenancy_id
     JOIN units u ON u.id = t.unit_id
     JOIN users usr ON usr.id = t.resident_user_id
     LEFT JOIN users actor ON actor.id = e.actor_user_id
     LEFT JOIN payments p ON p.id = e.payment_id
     WHERE e.period = $1 AND ($2::uuid IS NULL OR e.property_id = $2::uuid)
     ORDER BY u.label, e.effective_date, e.posted_at`,
    [options.period, options.propertyId ?? null],
  );

  const stamp = `${options.period}-${options.audience}`;

  if (options.format === "json") {
    return {
      filename: `ledger-${stamp}.json`,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(
        {
          period: options.period,
          periodLabel: describePeriod(options.period),
          audience: options.audience,
          generatedAt: new Date().toISOString(),
          rows: rows.map((row) => shapeRow(row, options.audience)),
        },
        null,
        2,
      ),
      rowCount: rows.length,
    };
  }

  const columns = columnsFor(options.audience);
  const lines = [columns.map((c) => c.header).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  }

  // A trailing total row, because the first thing anyone does with this file is
  // check that it sums to what the dashboard said.
  const total = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  lines.push("");
  lines.push(`"Total (${rows.length} entries)",${columns.length > 2 ? ",".repeat(columns.length - 3) : ""}"${formatDecimal(total as Cents)}"`);

  return {
    filename: `ledger-${stamp}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\r\n"),
    rowCount: rows.length,
  };
}

function shapeRow(row: ExportRow, audience: ExportAudience) {
  const base = {
    entryId: row.entry_id,
    postedAt: row.posted_at,
    effectiveDate: row.effective_date,
    period: row.period,
    unit: row.unit_label,
    entryType: row.entry_type,
    category: row.category,
    description: row.description,
    amount: formatDecimal(row.amount_cents as Cents),
  };

  // An owner gets the financial position without residents' names. Owners are
  // entitled to know what the building earned; they are not automatically
  // entitled to a list of who was short this month.
  if (audience === "owner") return base;

  return {
    ...base,
    resident: row.resident_name,
    receiptNumber: row.receipt_number,
    actor: row.actor_name ?? (row.actor_role === "system_job" ? "system (scheduled)" : null),
    actorRole: row.actor_role,
    reason: row.actor_reason,
    reversesEntryId: row.reverses_entry_id,
  };
}

function columnsFor(audience: ExportAudience): Array<{ header: string; value: (row: ExportRow) => string }> {
  const common = [
    { header: "Entry ID", value: (r: ExportRow) => r.entry_id },
    { header: "Posted", value: (r: ExportRow) => r.posted_at },
    { header: "Effective", value: (r: ExportRow) => r.effective_date },
    { header: "Period", value: (r: ExportRow) => r.period },
    { header: "Unit", value: (r: ExportRow) => r.unit_label },
  ];

  if (audience === "owner") {
    return [
      ...common,
      { header: "Type", value: (r: ExportRow) => r.entry_type },
      { header: "Category", value: (r: ExportRow) => r.category },
      { header: "Amount", value: (r: ExportRow) => formatDecimal(r.amount_cents as Cents) },
    ];
  }

  const withResident = [
    ...common,
    { header: "Resident", value: (r: ExportRow) => r.resident_name },
    { header: "Type", value: (r: ExportRow) => r.entry_type },
    { header: "Category", value: (r: ExportRow) => r.category },
    { header: "Description", value: (r: ExportRow) => r.description },
    { header: "Amount", value: (r: ExportRow) => formatDecimal(r.amount_cents as Cents) },
  ];

  if (audience === "accountant") {
    return [
      ...withResident,
      { header: "Receipt", value: (r: ExportRow) => r.receipt_number ?? "" },
      // The direction column exists because the sign convention is obvious to
      // this system and not to whoever opens the file in Excel.
      { header: "Direction", value: (r: ExportRow) => (r.amount_cents > 0 ? "charge" : "credit") },
    ];
  }

  // Legal: who did what and why, on every row.
  return [
    ...withResident,
    { header: "Receipt", value: (r: ExportRow) => r.receipt_number ?? "" },
    { header: "Entered by", value: (r: ExportRow) => r.actor_name ?? (r.actor_role === "system_job" ? "system (scheduled job)" : "") },
    { header: "Role", value: (r: ExportRow) => r.actor_role ?? "" },
    { header: "Stated reason", value: (r: ExportRow) => r.actor_reason ?? "" },
    { header: "Reverses", value: (r: ExportRow) => r.reverses_entry_id ?? "" },
  ];
}

/**
 * RFC 4180 quoting, plus the leading-character guard that stops a spreadsheet
 * from executing a cell. A resident can type `=HYPERLINK(...)` into a
 * maintenance description; if that reaches an accountant's Excel unescaped, this
 * system has handed a resident a way to run formulas on a manager's machine.
 */
function csvCell(value: string): string {
  const text = value ?? "";
  const dangerous = /^[=+\-@\t\r]/.test(text);
  const escaped = (dangerous ? `'${text}` : text).replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * A resident's own record, in full, as a text document they can keep or attach
 * to something. Residents are entitled to their data in a form they can use
 * elsewhere — the alternative is a portal that holds your record hostage to
 * having an account on it.
 */
export async function exportTenancyStatement(
  tx: Tx,
  tenancyId: string,
): Promise<ExportResult> {
  const tenancy = await tx.one<{
    unit_label: string;
    property_name: string;
    resident_name: string;
    starts_on: string;
    monthly_rent_cents: number;
  }>(
    `SELECT u.label AS unit_label, p.name AS property_name, usr.display_name AS resident_name,
            t.starts_on::text AS starts_on, t.monthly_rent_cents
     FROM tenancies t
     JOIN units u ON u.id = t.unit_id
     JOIN properties p ON p.id = t.property_id
     JOIN users usr ON usr.id = t.resident_user_id
     WHERE t.id = $1`,
    [tenancyId],
  );

  const rows = await tx.many<ExportRow>(
    `SELECT e.id AS entry_id, e.posted_at::text AS posted_at, e.effective_date::text AS effective_date,
            e.period, '' AS unit_label, '' AS resident_name,
            e.entry_type, e.category, e.description, e.amount_cents,
            actor.display_name AS actor_name, e.actor_role, e.actor_reason,
            e.reverses_entry_id, p.receipt_number
     FROM ledger_entries e
     LEFT JOIN users actor ON actor.id = e.actor_user_id
     LEFT JOIN payments p ON p.id = e.payment_id
     WHERE e.tenancy_id = $1
     ORDER BY e.effective_date, e.posted_at`,
    [tenancyId],
  );

  const lines = [
    "Account statement",
    `${tenancy.resident_name} — Unit ${tenancy.unit_label}, ${tenancy.property_name}`,
    `Tenancy began ${tenancy.starts_on} · Monthly rent ${formatDecimal(tenancy.monthly_rent_cents as Cents)}`,
    `Generated ${today()}`,
    "",
    "Date,Description,Charge,Credit,Balance,Entered by,Reason",
  ];

  let balance = 0;
  for (const row of rows) {
    balance += row.amount_cents;
    const charge = row.amount_cents > 0 ? formatDecimal(row.amount_cents as Cents) : "";
    const credit = row.amount_cents < 0 ? formatDecimal(Math.abs(row.amount_cents) as Cents) : "";
    lines.push(
      [
        csvCell(row.effective_date),
        csvCell(row.description),
        csvCell(charge),
        csvCell(credit),
        csvCell(formatDecimal(balance as Cents)),
        csvCell(row.actor_name ?? (row.actor_role === "system_job" ? "system (scheduled)" : "")),
        csvCell(row.actor_reason ?? ""),
      ].join(","),
    );
  }

  lines.push("");
  lines.push(`Closing balance,,,,"${formatDecimal(balance as Cents)}"`);

  return {
    filename: `statement-unit-${tenancy.unit_label}-${today()}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\r\n"),
    rowCount: rows.length,
  };
}
