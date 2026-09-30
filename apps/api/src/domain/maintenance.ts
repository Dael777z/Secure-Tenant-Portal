/**
 * Maintenance intake.
 *
 * The connection to the ledger is what earns this component its place: a request
 * resolved in a way that warrants a rent credit posts that credit as a linked
 * row, so the resident finds the money and its cause in one place instead of an
 * unexplained credit they are afraid to spend.
 *
 * The thread is append-only, like the ledger, for the same reason: a request
 * whose history can be edited is a request where "you never told me it was
 * scheduled" has no answer.
 */

import { randomBytes } from "node:crypto";
import type { Tx } from "../db/context.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";
import type {
  WorkOrder,
  WorkOrderCategory,
  WorkOrderEvent,
  WorkOrderPriority,
  WorkOrderStatus,
} from "../../../../packages/shared/src/maintenance.ts";
import { PRIORITY_TARGET_HOURS } from "../../../../packages/shared/src/maintenance.ts";
import { postEntry } from "./ledger.ts";
import { conflict, unprocessable } from "../http/errors.ts";

const WO_COLUMNS = `
  w.id, w.reference, w.tenancy_id, w.category, w.priority, w.status, w.title, w.description,
  w.entry_permission, w.submitted_at::text AS submitted_at,
  w.acknowledged_at::text AS acknowledged_at, w.resolved_at::text AS resolved_at,
  u.label AS unit_label, p.name AS property_name,
  assignee.display_name AS assigned_to_name,
  resident.display_name AS resident_name
`;

// The resident is joined through work_orders.resident_user_id rather than
// through the tenancy. On-site staff can read this path; they cannot read
// tenancies at all, because that row carries the lease's financial terms.
// See migration 010.
const WO_JOINS = `
  FROM work_orders w
  JOIN units u ON u.id = w.unit_id
  JOIN properties p ON p.id = w.property_id
  JOIN users resident ON resident.id = w.resident_user_id
  LEFT JOIN users assignee ON assignee.id = w.assigned_to_user_id
`;

type WorkOrderRow = {
  id: string;
  reference: string;
  tenancy_id: string;
  category: WorkOrderCategory;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  title: string;
  description: string;
  entry_permission: boolean;
  submitted_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  unit_label: string;
  property_name: string;
  assigned_to_name: string | null;
  resident_name: string | null;
};

export async function submit(
  tx: Tx,
  options: {
    tenancyId: string;
    category: WorkOrderCategory;
    priority: WorkOrderPriority;
    title: string;
    description: string;
    entryPermission: boolean;
    actorUserId: string;
    actorRole: string;
  },
): Promise<WorkOrder> {
  // Short and quotable: residents read this over the phone. Collisions are
  // handled by retrying rather than by lengthening it into a uuid.
  let reference = makeReference();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await tx.maybeOne<{ id: string }>("SELECT id FROM work_orders WHERE reference = $1", [reference]);
    if (!taken) break;
    reference = makeReference();
  }

  const created = await tx.one<{ id: string }>(
    `INSERT INTO work_orders (
       organization_id, property_id, unit_id, tenancy_id, resident_user_id, reference,
       category, priority, title, description, entry_permission, submitted_by_user_id
     )
     SELECT c.organization_id, c.property_id, c.unit_id, $1, c.resident_user_id,
            $2, $3, $4, $5, $6, $7, $8
     FROM app.work_order_context($1) c
     RETURNING id`,
    [
      options.tenancyId, reference, options.category, options.priority,
      options.title, options.description, options.entryPermission, options.actorUserId,
    ],
  );

  await appendEvent(tx, {
    workOrderId: created.id,
    tenancyId: options.tenancyId,
    kind: "status",
    toStatus: "submitted",
    note: null,
    authorUserId: options.actorUserId,
    authorRole: options.actorRole,
    visibleToResident: true,
  });

  return (await get(tx, created.id))!;
}

export interface UpdateOptions {
  workOrderId: string;
  status?: WorkOrderStatus;
  note?: string;
  visibleToResident: boolean;
  assignedToUserId?: string | null;
  creditCents?: number;
  creditReason?: string;
  actorUserId: string;
  actorRole: string;
}

export async function update(tx: Tx, options: UpdateOptions): Promise<WorkOrder> {
  const current = await tx.maybeOne<{ id: string; status: WorkOrderStatus; tenancy_id: string; reference: string }>(
    "SELECT id, status, tenancy_id, reference FROM work_orders WHERE id = $1",
    [options.workOrderId],
  );
  if (!current) throw unprocessable("No such maintenance request.");

  let creditEntryId: string | null = null;

  if (options.creditCents !== undefined) {
    if (options.creditCents <= 0) throw unprocessable("A credit must be a positive amount.");
    if (!options.creditReason || options.creditReason.trim().length < 4) {
      throw unprocessable("Please state what the credit is for. The resident sees this on their ledger.");
    }

    // The credit is linked to the request, which is the whole reason maintenance
    // and the ledger live in the same system.
    const entry = await postEntry(tx, {
      tenancyId: current.tenancy_id,
      entryType: "credit",
      category: "maintenance_credit",
      amountCents: -options.creditCents,
      description: `Credit for maintenance request ${current.reference} — ${options.creditReason}`,
      workOrderId: current.id,
      actorUserId: options.actorUserId,
      actorRole: options.actorRole,
      actorReason: options.creditReason,
      idempotencyKey: `wo_credit:${current.id}:${options.creditCents}`,
    });
    creditEntryId = entry.id;

    await appendEvent(tx, {
      workOrderId: current.id,
      tenancyId: current.tenancy_id,
      kind: "credit",
      note: `Credit of $${(options.creditCents / 100).toFixed(2)} applied — ${options.creditReason}`,
      authorUserId: options.actorUserId,
      authorRole: options.actorRole,
      visibleToResident: true,
      linkedLedgerEntryId: creditEntryId,
    });
  }

  if (options.assignedToUserId !== undefined) {
    await tx.query("UPDATE work_orders SET assigned_to_user_id = $2 WHERE id = $1", [
      current.id,
      options.assignedToUserId,
    ]);
  }

  if (options.status && options.status !== current.status) {
    try {
      await tx.query(
        `UPDATE work_orders SET
           status = $2,
           acknowledged_at = CASE WHEN acknowledged_at IS NULL AND $2 <> 'submitted' THEN now() ELSE acknowledged_at END,
           resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now()
                              WHEN $2 = 'in_progress' THEN NULL
                              ELSE resolved_at END
         WHERE id = $1`,
        [current.id, options.status],
      );
    } catch (error) {
      throw conflict(`A request that is ${current.status} cannot move to ${options.status}.`);
    }

    await appendEvent(tx, {
      workOrderId: current.id,
      tenancyId: current.tenancy_id,
      kind: "status",
      fromStatus: current.status,
      toStatus: options.status,
      note: options.note ?? null,
      authorUserId: options.actorUserId,
      authorRole: options.actorRole,
      visibleToResident: options.visibleToResident,
    });
  } else if (options.note) {
    await appendEvent(tx, {
      workOrderId: current.id,
      tenancyId: current.tenancy_id,
      kind: "note",
      note: options.note,
      authorUserId: options.actorUserId,
      authorRole: options.actorRole,
      visibleToResident: options.visibleToResident,
    });
  }

  return (await get(tx, current.id))!;
}

async function appendEvent(
  tx: Tx,
  options: {
    workOrderId: string;
    tenancyId: string;
    kind: "status" | "note" | "photo" | "credit";
    fromStatus?: WorkOrderStatus | null;
    toStatus?: WorkOrderStatus | null;
    note: string | null;
    authorUserId: string | null;
    authorRole: string;
    visibleToResident: boolean;
    linkedLedgerEntryId?: string | null;
  },
): Promise<void> {
  // Sourced from the work order itself: staff append events and cannot read
  // the tenancy row.
  await tx.query(
    `INSERT INTO work_order_events
       (work_order_id, property_id, tenancy_id, kind, from_status, to_status, note,
        author_user_id, author_role, visible_to_resident, linked_ledger_entry_id)
     SELECT w.id, w.property_id, w.tenancy_id, $3, $4, $5, $6, $7, $8, $9, $10
     FROM work_orders w WHERE w.id = $1 AND w.tenancy_id = $2`,
    [
      options.workOrderId, options.tenancyId, options.kind,
      options.fromStatus ?? null, options.toStatus ?? null, options.note,
      options.authorUserId, options.authorRole, options.visibleToResident,
      options.linkedLedgerEntryId ?? null,
    ],
  );
}

export async function get(tx: Tx, workOrderId: string): Promise<WorkOrder | null> {
  const row = await tx.maybeOne<WorkOrderRow>(`SELECT ${WO_COLUMNS} ${WO_JOINS} WHERE w.id = $1`, [workOrderId]);
  if (!row) return null;

  const [events, photos, credit] = await Promise.all([
    tx.many<{
      id: string;
      occurred_at: string;
      kind: WorkOrderEvent["kind"];
      from_status: WorkOrderStatus | null;
      to_status: WorkOrderStatus | null;
      note: string | null;
      author_name: string | null;
      author_role: string | null;
      visible_to_resident: boolean;
      linked_ledger_entry_id: string | null;
    }>(
      `SELECT e.id, e.occurred_at::text AS occurred_at, e.kind, e.from_status, e.to_status, e.note,
              a.display_name AS author_name, e.author_role, e.visible_to_resident, e.linked_ledger_entry_id
       FROM work_order_events e
       LEFT JOIN users a ON a.id = e.author_user_id
       WHERE e.work_order_id = $1
       ORDER BY e.occurred_at`,
      [workOrderId],
    ),
    tx.many<{ id: string; object_key: string; content_type: string; size_bytes: number; uploaded_at: string }>(
      `SELECT id, object_key, content_type, size_bytes, uploaded_at::text AS uploaded_at
       FROM work_order_photos WHERE work_order_id = $1 ORDER BY uploaded_at`,
      [workOrderId],
    ),
    tx.maybeOne<{ id: string; amount_cents: number }>(
      `SELECT id, amount_cents FROM ledger_entries
       WHERE work_order_id = $1 AND entry_type = 'credit' ORDER BY posted_at DESC LIMIT 1`,
      [workOrderId],
    ),
  ]);

  return {
    id: row.id,
    reference: row.reference,
    tenancyId: row.tenancy_id,
    unitLabel: row.unit_label,
    propertyName: row.property_name,
    category: row.category,
    priority: row.priority,
    status: row.status,
    title: row.title,
    description: row.description,
    entryPermission: row.entry_permission,
    submittedAt: row.submitted_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    assignedToName: row.assigned_to_name,
    residentName: row.resident_name,
    // The URL is minted by the route handler, which knows the request's identity
    // and can sign a link scoped to it. These are photographs of the inside of
    // somebody's home; a permanent public URL for one is not acceptable.
    photos: photos.map((photo) => ({
      id: photo.id,
      url: `/api/v1/photos/${photo.id}`,
      contentType: photo.content_type,
      sizeBytes: photo.size_bytes,
      uploadedAt: photo.uploaded_at,
    })),
    events: events.map((event) => ({
      id: event.id,
      at: event.occurred_at,
      kind: event.kind,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      note: event.note,
      authorName: event.author_name,
      authorRole: event.author_role,
      visibleToResident: event.visible_to_resident,
      linkedLedgerEntryId: event.linked_ledger_entry_id,
    })),
    creditCents: credit ? (Math.abs(credit.amount_cents) as Cents) : null,
    creditLedgerEntryId: credit?.id ?? null,
  };
}

export async function listForTenancy(tx: Tx, tenancyId: string, openOnly = false): Promise<WorkOrder[]> {
  const rows = await tx.many<WorkOrderRow>(
    `SELECT ${WO_COLUMNS} ${WO_JOINS}
     WHERE w.tenancy_id = $1
       AND ($2 = false OR w.status IN ('submitted','acknowledged','scheduled','in_progress'))
     ORDER BY w.submitted_at DESC`,
    [tenancyId, openOnly],
  );
  return Promise.all(rows.map((row) => get(tx, row.id))) as Promise<WorkOrder[]>;
}

export async function listForProperty(
  tx: Tx,
  options: { propertyId?: string; status?: WorkOrderStatus | "open" | "all"; limit?: number },
): Promise<WorkOrder[]> {
  const rows = await tx.many<WorkOrderRow>(
    `SELECT ${WO_COLUMNS} ${WO_JOINS}
     WHERE ($1::uuid IS NULL OR w.property_id = $1::uuid)
       AND ($2::text = 'all'
            OR ($2::text = 'open' AND w.status IN ('submitted','acknowledged','scheduled','in_progress'))
            OR w.status = $2::text)
     ORDER BY
       -- Emergencies first, then oldest, which is the order a person should
       -- work the queue rather than the order the rows happen to come back.
       CASE w.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
       w.submitted_at
     LIMIT $3`,
    [options.propertyId ?? null, options.status ?? "open", options.limit ?? 200],
  );
  return Promise.all(rows.map((row) => get(tx, row.id))) as Promise<WorkOrder[]>;
}

export async function attachPhoto(
  tx: Tx,
  options: {
    workOrderId: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    actorUserId: string;
    actorRole: string;
  },
): Promise<string> {
  const workOrder = await tx.maybeOne<{ tenancy_id: string }>(
    "SELECT tenancy_id FROM work_orders WHERE id = $1",
    [options.workOrderId],
  );
  if (!workOrder) throw unprocessable("No such maintenance request.");

  const row = await tx.one<{ id: string }>(
    `INSERT INTO work_order_photos
       (work_order_id, property_id, tenancy_id, object_key, content_type, size_bytes, uploaded_by_user_id)
     SELECT w.id, w.property_id, w.tenancy_id, $3, $4, $5, $6
     FROM work_orders w WHERE w.id = $1 AND w.tenancy_id = $2
     RETURNING id`,
    [
      options.workOrderId, workOrder.tenancy_id, options.objectKey,
      options.contentType, options.sizeBytes, options.actorUserId,
    ],
  );

  await appendEvent(tx, {
    workOrderId: options.workOrderId,
    tenancyId: workOrder.tenancy_id,
    kind: "photo",
    note: "A photo was added.",
    authorUserId: options.actorUserId,
    authorRole: options.actorRole,
    visibleToResident: true,
  });

  return row.id;
}

export function targetHoursFor(priority: WorkOrderPriority): number {
  return PRIORITY_TARGET_HOURS[priority];
}

function makeReference(): string {
  // Base32 without I, L, O, U — the characters people misread or misdictate.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(4);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `WO-${out}`;
}
