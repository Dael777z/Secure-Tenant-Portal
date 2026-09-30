/**
 * Charge disputes.
 *
 * A resident objects to a specific row; the manager's answer attaches to that
 * same row. Neither party keeps a private record of the exchange, and neither
 * has to produce one later — the objection, the answer, and any correction all
 * live with the charge.
 *
 * While a dispute is open, late-fee accrual on the account is suspended (see
 * latefees.ts). Fees compounding on top of an amount that is itself under review
 * is how a $40 disagreement becomes a $300 one.
 */

import type { Tx } from "../db/context.ts";
import type { ChargeDispute, DisputeStatus } from "../../../../packages/shared/src/maintenance.ts";
import { reverseEntry } from "./ledger.ts";
import { conflict, unprocessable } from "../http/errors.ts";
import { PostgresError } from "../db/protocol.ts";

const COLUMNS = `
  d.id, d.ledger_entry_id, d.tenancy_id, d.status, d.reason,
  d.opened_at::text AS opened_at, d.response, d.responded_at::text AS responded_at,
  d.resolution_entry_id,
  opener.display_name AS opened_by_name,
  responder.display_name AS responded_by_name
`;

type DisputeRow = {
  id: string;
  ledger_entry_id: string;
  tenancy_id: string;
  status: DisputeStatus;
  reason: string;
  opened_at: string;
  response: string | null;
  responded_at: string | null;
  resolution_entry_id: string | null;
  opened_by_name: string | null;
  responded_by_name: string | null;
};

const toDispute = (row: DisputeRow): ChargeDispute => ({
  id: row.id,
  ledgerEntryId: row.ledger_entry_id,
  tenancyId: row.tenancy_id,
  status: row.status,
  reason: row.reason,
  openedAt: row.opened_at,
  openedByName: row.opened_by_name,
  response: row.response,
  respondedAt: row.responded_at,
  respondedByName: row.responded_by_name,
  resolutionEntryId: row.resolution_entry_id,
});

export async function openDispute(
  tx: Tx,
  options: { ledgerEntryId: string; tenancyId: string; reason: string; actorUserId: string },
): Promise<ChargeDispute> {
  const entry = await tx.maybeOne<{ id: string; amount_cents: number; entry_type: string }>(
    "SELECT id, amount_cents, entry_type FROM ledger_entries WHERE id = $1 AND tenancy_id = $2",
    [options.ledgerEntryId, options.tenancyId],
  );
  if (!entry) throw unprocessable("That charge is not on your account.");
  if (entry.entry_type === "annotation") {
    throw unprocessable("That entry is a note rather than a charge, so there is nothing to dispute.");
  }

  try {
    // Insert, then read back: a data-modifying CTE is invisible to the
    // enclosing query's snapshot in PostgreSQL.
    const inserted = await tx.one<{ id: string }>(
      `INSERT INTO charge_disputes
         (organization_id, property_id, tenancy_id, ledger_entry_id, reason, opened_by_user_id)
       SELECT t.organization_id, t.property_id, t.id, $2, $3, $4
       FROM tenancies t WHERE t.id = $1
       RETURNING id`,
      [options.tenancyId, options.ledgerEntryId, options.reason, options.actorUserId],
    );
    const row = await tx.one<DisputeRow>(
      `SELECT ${COLUMNS} FROM charge_disputes d
       LEFT JOIN users opener ON opener.id = d.opened_by_user_id
       LEFT JOIN users responder ON responder.id = d.responded_by_user_id
       WHERE d.id = $1`,
      [inserted.id],
    );
    return toDispute(row);
  } catch (error) {
    // Safe to catch here, unlike the idempotent write paths: this throws
    // rather than continuing, so the transaction unwinds instead of being used
    // after PostgreSQL has aborted it.
    if (error instanceof PostgresError && error.isUniqueViolation) {
      throw conflict(
        "There is already an open dispute on this charge. Your manager will respond on that one.",
      );
    }
    throw error;
  }
}

export async function respond(
  tx: Tx,
  options: {
    disputeId: string;
    response: string;
    resolution: "upheld" | "adjusted" | "responded";
    adjustmentCents?: number;
    actorUserId: string;
    actorRole: string;
  },
): Promise<ChargeDispute> {
  const dispute = await tx.maybeOne<{
    id: string;
    ledger_entry_id: string;
    tenancy_id: string;
    status: DisputeStatus;
  }>(
    "SELECT id, ledger_entry_id, tenancy_id, status FROM charge_disputes WHERE id = $1",
    [options.disputeId],
  );
  if (!dispute) throw unprocessable("No such dispute.");
  if (dispute.status.startsWith("resolved") || dispute.status === "withdrawn") {
    throw conflict("That dispute has already been resolved.");
  }

  let resolutionEntryId: string | null = null;

  if (options.resolution === "adjusted") {
    // Resolving in the resident's favour posts a reversal against the disputed
    // row, linked to the dispute, so the correction and its cause are one story.
    const { reversal } = await reverseEntry(tx, {
      entryId: dispute.ledger_entry_id,
      amountCents: options.adjustmentCents,
      reason: options.response,
      actorUserId: options.actorUserId,
      actorRole: options.actorRole,
      description: `Adjusted after dispute — ${options.response.slice(0, 200)}`,
      disputeId: dispute.id,
    });
    resolutionEntryId = reversal.id;
  }

  const status: DisputeStatus =
    options.resolution === "adjusted"
      ? "resolved_adjusted"
      : options.resolution === "upheld"
        ? "resolved_upheld"
        : "responded";

  await tx.query(
    `UPDATE charge_disputes
     SET status = $2, response = $3, responded_by_user_id = $4, responded_at = now(),
         resolution_entry_id = COALESCE($5, resolution_entry_id)
     WHERE id = $1`,
    [options.disputeId, status, options.response, options.actorUserId, resolutionEntryId],
  );

  const row = await tx.one<DisputeRow>(
    `SELECT ${COLUMNS} FROM charge_disputes d
     LEFT JOIN users opener ON opener.id = d.opened_by_user_id
     LEFT JOIN users responder ON responder.id = d.responded_by_user_id
     WHERE d.id = $1`,
    [options.disputeId],
  );

  return toDispute(row);
}

export async function withdraw(tx: Tx, disputeId: string, tenancyId: string): Promise<void> {
  await tx.query(
    `UPDATE charge_disputes SET status = 'withdrawn'
     WHERE id = $1 AND tenancy_id = $2 AND status IN ('open','responded')`,
    [disputeId, tenancyId],
  );
}

export async function listForTenancy(tx: Tx, tenancyId: string, openOnly = false): Promise<ChargeDispute[]> {
  const rows = await tx.many<DisputeRow>(
    `SELECT ${COLUMNS} FROM charge_disputes d
     LEFT JOIN users opener ON opener.id = d.opened_by_user_id
     LEFT JOIN users responder ON responder.id = d.responded_by_user_id
     WHERE d.tenancy_id = $1 AND ($2 = false OR d.status IN ('open','responded'))
     ORDER BY d.opened_at DESC`,
    [tenancyId, openOnly],
  );
  return rows.map(toDispute);
}

export async function getDispute(tx: Tx, disputeId: string): Promise<ChargeDispute | null> {
  const row = await tx.maybeOne<DisputeRow>(
    `SELECT ${COLUMNS} FROM charge_disputes d
     LEFT JOIN users opener ON opener.id = d.opened_by_user_id
     LEFT JOIN users responder ON responder.id = d.responded_by_user_id
     WHERE d.id = $1`,
    [disputeId],
  );
  return row ? toDispute(row) : null;
}

export async function forEntry(tx: Tx, ledgerEntryId: string): Promise<ChargeDispute | null> {
  const row = await tx.maybeOne<DisputeRow>(
    `SELECT ${COLUMNS} FROM charge_disputes d
     LEFT JOIN users opener ON opener.id = d.opened_by_user_id
     LEFT JOIN users responder ON responder.id = d.responded_by_user_id
     WHERE d.ledger_entry_id = $1 ORDER BY d.opened_at DESC LIMIT 1`,
    [ledgerEntryId],
  );
  return row ? toDispute(row) : null;
}
