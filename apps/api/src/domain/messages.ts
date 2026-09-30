/**
 * Messages between a resident and management (migration 011).
 *
 * Threads belong to a tenancy. Every query below runs under the caller's
 * Row-Level Security context, so "list threads" needs no WHERE clause to be
 * safe: a resident gets their own, a manager gets their properties', on-site
 * staff get maintenance threads only, and an owner gets none. The filters that
 * do appear are for narrowing, not for isolation.
 */

import type { Tx } from "../db/context.ts";
import type { MessageThread, Message, MessageTopic } from "../../../../packages/shared/src/api.ts";

interface ThreadRow {
  id: string;
  tenancy_id: string;
  property_id: string;
  property_name: string;
  unit_label: string;
  resident_name: string | null;
  subject: string;
  topic: MessageTopic;
  status: "open" | "closed";
  ledger_entry_id: string | null;
  work_order_id: string | null;
  created_by_role: string;
  created_at: string;
  last_message_at: string;
  message_count: number;
  unread_count: number;
  last_body: string | null;
  last_author_name: string | null;
  last_author_role: string | null;
}

// Unit and resident come from columns on the thread (011), not from the
// tenancy row, which on-site staff cannot read (010). users_read lets staff and
// managers read resident names at their properties, and a resident their own.
const THREAD_SELECT = `
  SELECT th.id, th.tenancy_id, th.property_id, p.name AS property_name, u.label AS unit_label,
         usr.display_name AS resident_name, th.subject, th.topic, th.status,
         th.ledger_entry_id, th.work_order_id, th.created_by_role,
         th.created_at::text AS created_at, th.last_message_at::text AS last_message_at,
         (SELECT count(*) FROM messages m WHERE m.thread_id = th.id)::int AS message_count,
         (SELECT count(*) FROM messages m
            WHERE m.thread_id = th.id
              AND m.author_user_id <> app.current_user_id()
              AND m.created_at > COALESCE(
                (SELECT r.last_read_at FROM message_reads r
                  WHERE r.thread_id = th.id AND r.user_id = app.current_user_id()),
                '-infinity'::timestamptz))::int AS unread_count,
         last.body AS last_body, last.author_name AS last_author_name, last.author_role AS last_author_role
  FROM message_threads th
  JOIN properties p ON p.id = th.property_id
  JOIN units u ON u.id = th.unit_id
  LEFT JOIN users usr ON usr.id = th.resident_user_id
  LEFT JOIN LATERAL (
    SELECT m.body, m.author_name, m.author_role FROM messages m
    WHERE m.thread_id = th.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ) last ON true`;

function mapThread(row: ThreadRow): MessageThread {
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    unitLabel: row.unit_label,
    residentName: row.resident_name,
    subject: row.subject,
    topic: row.topic,
    status: row.status,
    ledgerEntryId: row.ledger_entry_id,
    workOrderId: row.work_order_id,
    startedBy: row.created_by_role === "tenant" ? "resident" : "management",
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    lastMessagePreview: row.last_body ? row.last_body.slice(0, 160) : null,
    lastAuthorName: row.last_author_name,
    lastFromResident: row.last_author_role === "tenant",
  };
}

export async function listThreads(
  tx: Tx,
  options: { tenancyId?: string; propertyId?: string; status?: "open" | "closed" | "all"; unreadOnly?: boolean; limit?: number } = {},
): Promise<MessageThread[]> {
  const rows = await tx.many<ThreadRow>(
    `SELECT * FROM (${THREAD_SELECT}
       WHERE ($1::uuid IS NULL OR th.tenancy_id = $1::uuid)
         AND ($2::uuid IS NULL OR th.property_id = $2::uuid)
         AND ($3::text = 'all' OR th.status = $3::text)
     ) x
     WHERE ($4::boolean = false OR x.unread_count > 0)
     ORDER BY x.last_message_at DESC
     LIMIT $5`,
    [options.tenancyId ?? null, options.propertyId ?? null, options.status ?? "all", options.unreadOnly ?? false, options.limit ?? 200],
  );
  return rows.map(mapThread);
}

export async function getThread(tx: Tx, threadId: string): Promise<{ thread: MessageThread; messages: Message[] } | null> {
  const row = await tx.maybeOne<ThreadRow>(`${THREAD_SELECT} WHERE th.id = $1`, [threadId]);
  if (!row) return null;
  const messages = await tx.many<{
    id: string;
    author_user_id: string;
    author_role: string;
    author_name: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, author_user_id, author_role, author_name, body, created_at::text AS created_at
     FROM messages WHERE thread_id = $1 ORDER BY created_at, id`,
    [threadId],
  );
  return {
    thread: mapThread(row),
    messages: messages.map((m) => ({
      id: m.id,
      authorName: m.author_name,
      authorRole: m.author_role,
      fromResident: m.author_role === "tenant",
      mine: m.author_user_id === tx.context.userId,
      body: m.body,
      createdAt: m.created_at,
    })),
  };
}

/** Mark a thread read up to now for the caller. */
export async function markRead(tx: Tx, threadId: string): Promise<void> {
  await tx.query(
    `INSERT INTO message_reads (thread_id, user_id, last_read_at)
     SELECT $1, app.current_user_id(), now()
     WHERE EXISTS (SELECT 1 FROM message_threads WHERE id = $1)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`,
    [threadId],
  );
}

async function authorName(tx: Tx): Promise<string> {
  const me = await tx.one<{ display_name: string }>(
    "SELECT display_name FROM users WHERE id = app.current_user_id()",
  );
  return me.display_name;
}

export async function startThread(
  tx: Tx,
  options: {
    tenancyId: string;
    subject: string;
    topic: MessageTopic;
    body: string;
    ledgerEntryId?: string | null;
    workOrderId?: string | null;
  },
): Promise<string> {
  // Where the thread lives (organization, property, unit, resident) is filled in
  // by the message_threads_from_tenancy trigger through a scoped lookup; a
  // tenancy the caller cannot reach is refused there. Checked here first only
  // to give a clear message instead of a database error.
  const reachable = await tx.maybeOne<{ ok: boolean }>(
    "SELECT true AS ok FROM app.work_order_context($1)",
    [options.tenancyId],
  );
  if (!reachable) throw new ThreadRefused("That resident is not one you can message.");

  // A link must point at a row of the same tenancy, or it is dropped.
  const ledgerEntryId = options.ledgerEntryId
    ? (await tx.maybeOne<{ id: string }>(
        "SELECT id FROM ledger_entries WHERE id = $1 AND tenancy_id = $2",
        [options.ledgerEntryId, options.tenancyId],
      ))?.id ?? null
    : null;
  const workOrderId = options.workOrderId
    ? (await tx.maybeOne<{ id: string }>(
        "SELECT id FROM work_orders WHERE id = $1 AND tenancy_id = $2",
        [options.workOrderId, options.tenancyId],
      ))?.id ?? null
    : null;

  const thread = await tx.one<{ id: string }>(
    `INSERT INTO message_threads
       (tenancy_id, subject, topic, ledger_entry_id, work_order_id, created_by_user_id, created_by_role)
     VALUES ($1, $2, $3, $4, $5, app.current_user_id(), $6)
     RETURNING id`,
    [options.tenancyId, options.subject, options.topic, ledgerEntryId, workOrderId, tx.context.role],
  );
  await addMessage(tx, thread.id, options.body);
  return thread.id;
}

export class ThreadRefused extends Error {}

export async function addMessage(tx: Tx, threadId: string, body: string): Promise<Message> {
  const name = await authorName(tx);
  const row = await tx.one<{ id: string; created_at: string }>(
    `INSERT INTO messages (thread_id, organization_id, property_id, tenancy_id, author_user_id, author_role, author_name, body)
     SELECT $1, th.organization_id, th.property_id, th.tenancy_id, app.current_user_id(), $2, $3, $4
     FROM message_threads th WHERE th.id = $1
     RETURNING id, created_at::text AS created_at`,
    [threadId, tx.context.role, name, body],
  );
  await tx.query("UPDATE message_threads SET last_message_at = now() WHERE id = $1", [threadId]);
  await markRead(tx, threadId);
  return {
    id: row.id,
    authorName: name,
    authorRole: tx.context.role,
    fromResident: tx.context.role === "tenant",
    mine: true,
    body,
    createdAt: row.created_at,
  };
}

export async function setStatus(tx: Tx, threadId: string, status: "open" | "closed"): Promise<boolean> {
  const result = await tx.query(
    `UPDATE message_threads
     SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END
     WHERE id = $1`,
    [threadId, status],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Unread threads for the caller — the badge on the nav and the mobile quick action. */
export async function unreadThreadCount(tx: Tx): Promise<number> {
  const threads = await listThreads(tx, { status: "all", unreadOnly: true, limit: 500 });
  return threads.length;
}
