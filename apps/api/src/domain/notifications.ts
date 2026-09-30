/**
 * Notification dispatch.
 *
 * Two properties are load-bearing here, and both are tested rather than assumed.
 *
 * Exactly once. An event is recorded under a key derived from what happened, and
 * a delivery is unique per (event, channel, recipient). A replayed webhook, a
 * re-run job, or a retried send finds the row already there and does nothing.
 * The failure mode this prevents is not abstract: four copies of the same late
 * notice reaching someone who is already worried about their rent.
 *
 * Specific content. Every template below states the amount, the date, the
 * reason, and what happens next. A notice that says "there was a problem with
 * your payment" and stops is what sends a worried person to the phone — the
 * friction this project is supposed to remove rather than relocate. These
 * messages are written to be read cold, at a bad moment, by someone who did not
 * ask to receive them.
 */

import type { Tx } from "../db/context.ts";
import type { EventType, NotificationAudience, NotificationChannel } from "../../../../packages/shared/src/notifications.ts";
import { EVENT_CATALOG } from "../../../../packages/shared/src/notifications.ts";
import { formatMoney } from "../../../../packages/shared/src/money.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";

export interface EmitOptions {
  eventType: EventType;
  dedupeKey: string;
  tenancyId?: string | null;
  propertyId?: string | null;
  payload: Record<string, unknown>;
  /**
   * Split-rent autopay (021): tell only this resident, not everyone on the
   * lease. A roommate's share is theirs to hear about. Staff audiences are
   * unaffected.
   */
  onlyResidentUserId?: string | null;
}

export interface Recipient {
  audience: NotificationAudience;
  channel: NotificationChannel;
  address: string;
  name: string;
}

export interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * Record an event and queue its deliveries.
 *
 * Returns the number of deliveries created, which is zero for an event that has
 * already been emitted. Callers do not need to check first — that is the point.
 */
export async function emit(tx: Tx, options: EmitOptions): Promise<number> {
  const definition = EVENT_CATALOG[options.eventType];
  if (!definition) throw new Error(`unknown event type: ${options.eventType}`);

  // ON CONFLICT rather than catch-and-continue: a failed statement aborts the
  // whole transaction in PostgreSQL, so catching a unique violation here and
  // carrying on would fail on the next query with "current transaction is
  // aborted" — precisely on the webhook retry this deduplication exists for.
  const inserted = await tx.maybeOne<{ id: string }>(
    `INSERT INTO notification_events (organization_id, property_id, tenancy_id, event_type, dedupe_key, payload)
     SELECT s.organization_id, s.property_id, $1::uuid, $3, $4, $5::jsonb
     -- Routing through a definer function (013): the caller may be a resident
     -- or on-site staff, who cannot read the tenancy row itself.
     FROM app.notification_scope($1::uuid, $2::uuid) s
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      options.tenancyId ?? null,
      options.propertyId ?? null,
      options.eventType,
      options.dedupeKey,
      JSON.stringify(options.payload),
    ],
  );

  // Already emitted. The ordinary case on a retry: say nothing, send nothing.
  if (!inserted) return 0;
  const eventId = inserted.id;

  const recipients = await resolveRecipients(tx, options, definition.audiences, definition.channels);
  let created = 0;

  for (const recipient of recipients) {
    const message = render(options.eventType, recipient, options.payload);
    // Through a definer function (013): the caller may be allowed to cause
    // this email but not to read its row afterwards.
    const queued = await tx.one<{ n: number }>(
      "SELECT app.enqueue_delivery($1, $2, $3, $4, $5, $6) AS n",
      [eventId, recipient.audience, recipient.channel, recipient.address, message.subject, message.body],
    );
    created += Number(queued.n);
  }

  return created;
}

async function resolveRecipients(
  tx: Tx,
  options: EmitOptions,
  audiences: readonly NotificationAudience[],
  channels: readonly NotificationChannel[],
): Promise<Recipient[]> {
  const out: Recipient[] = [];

  let onlyEmail: string | null = null;
  if (options.onlyResidentUserId) {
    const person = await tx.maybeOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      options.onlyResidentUserId,
    ]);
    onlyEmail = person?.email ?? "";
  }

  for (const audience of audiences) {
    // Who hears about an event is not something the caller's own RLS context
    // should decide — a resident cannot see the staff roster, and staff cannot
    // see tenancy rows. app.notification_recipients (013) answers it, and only
    // for a tenancy or property the caller can already reach.
    const people = await tx.many<{ email: string; phone: string | null; display_name: string }>(
      "SELECT email, phone, display_name FROM app.notification_recipients($1::uuid, $2::uuid, $3)",
      [options.tenancyId ?? null, options.propertyId ?? null, audience],
    );

    for (const person of people) {
      if (audience === "resident" && onlyEmail !== null && person.email !== onlyEmail) continue;
      if (audience === "resident") {
        for (const channel of channels) {
          // SMS only where we actually have a number. A queued delivery to a null
          // address is a permanently-failing row that pollutes the retry queue.
          if (channel === "sms" && !person.phone) continue;
          out.push({
            audience,
            channel,
            address: channel === "sms" ? person.phone! : person.email,
            name: person.display_name,
          });
        }
        continue;
      }
      // Staff and managers get email only. Waking somebody at 2am by text
      // because a routine ACH debit failed is how notifications get muted.
      out.push({ audience, channel: "email", address: person.email, name: person.display_name });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const money = (value: unknown): string => formatMoney(Number(value ?? 0) as Cents);

function render(
  eventType: EventType,
  recipient: Recipient,
  payload: Record<string, unknown>,
): RenderedMessage {
  const first = recipient.name.split(" ")[0];

  if (recipient.channel === "sms") {
    return { subject: "", body: renderSms(eventType, payload) };
  }

  switch (eventType) {
    case "payment.receipt":
      return {
        subject: `Payment received — ${money(payload.amountCents)} (receipt ${payload.receiptNumber})`,
        body: [
          `Hi ${first},`,
          ``,
          `We received your payment of ${money(payload.amountCents)} from ${payload.methodLabel ?? "your payment method"}.`,
          ``,
          `Receipt number: ${payload.receiptNumber}`,
          `Your balance is now ${money(payload.balanceCents)}.`,
          ``,
          `This receipt is also saved in your account, and stays there. You do not need to keep this email as proof.`,
        ].join("\n"),
      };

    case "payment.failed":
    case "payment.returned": {
      const returned = eventType === "payment.returned";
      return {
        subject: returned
          ? `Your bank returned a payment of ${money(payment(payload))}`
          : `Your payment of ${money(payment(payload))} did not go through`,
        body: [
          `Hi ${first},`,
          ``,
          returned
            ? `A payment of ${money(payment(payload))} that had gone through was returned by your bank. The amount has been added back to your balance.`
            : `A payment of ${money(payment(payload))} did not complete.`,
          ``,
          `What happened: ${payload.failureMessage ?? "The payment could not be completed."}`,
          ``,
          // The pause is stated first, because it is the part that changes what
          // the reader needs to do in the next five minutes.
          `Late fees on your account are paused until ${payload.feesPausedUntil}. You will not be charged a late fee while this is sorted out.`,
          ``,
          `What to do next: sign in and either retry with the same method or add a different one. If you think this is a mistake on the bank's side, contacting them usually clears it.`,
          ``,
          `If none of this is right, you can dispute the charge from your ledger and a person will read it.`,
        ].join("\n"),
      };
    }

    case "charge.upcoming":
      return {
        subject: `Rent of ${money(payload.amountCents)} is due ${payload.dueDate}`,
        body: [
          `Hi ${first},`,
          ``,
          `This is a reminder that ${money(payload.amountCents)} is due on ${payload.dueDate}.`,
          payload.autopayScheduled
            ? `\nAutopay is on, so ${money(payload.amountCents)} will be drafted automatically from ${payload.methodLabel}. You do not need to do anything.`
            : `\nYou can pay from your account at any time before then.`,
          ``,
          `Your current balance is ${money(payload.balanceCents)}.`,
        ].join("\n"),
      };

    case "charge.posted":
      return {
        subject: `A charge of ${money(payload.amountCents)} was added to your account`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.description}`,
          `Amount: ${money(payload.amountCents)}`,
          `Effective: ${payload.effectiveDate}`,
          ``,
          `Your balance is now ${money(payload.balanceCents)}.`,
          ``,
          `Every charge on your account shows what produced it. If this one does not look right, you can dispute it from your ledger.`,
        ].join("\n"),
      };

    case "balance.past_due":
      return {
        subject: `Your balance of ${money(payload.balanceCents)} is past due`,
        body: [
          `Hi ${first},`,
          ``,
          `Your account has a balance of ${money(payload.balanceCents)}, and the oldest unpaid charge is now ${payload.daysPastDue} days old.`,
          ``,
          `${payload.policyText ?? ""}`,
          ``,
          `If paying the full amount is not possible right now, you can ask the office about a payment plan. A plan that is being followed pauses late fees, and it is recorded on your account so there is no question later about what was agreed.`,
        ].join("\n"),
      };

    case "late_fee.assessed":
      return {
        subject: `A late fee of ${money(payload.amountCents)} was added`,
        body: [
          `Hi ${first},`,
          ``,
          `A late fee of ${money(payload.amountCents)} has been added to your account.`,
          ``,
          `Why: ${payload.detail}`,
          `${payload.policyText ?? ""}`,
          ``,
          `Your balance is now ${money(payload.balanceCents)}.`,
          ``,
          `If you believe this fee is wrong, you can dispute it directly from the charge in your ledger. Fees stop accruing while a charge is under dispute.`,
        ].join("\n"),
      };

    case "late_fee.waived":
      return {
        subject: `A fee of ${money(payload.amountCents)} was removed from your account`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.actorName ?? "Your property manager"} removed a fee of ${money(payload.amountCents)} from your account.`,
          ``,
          `Reason given: ${payload.reason}`,
          ``,
          `Your balance is now ${money(payload.balanceCents)}. This is recorded on your ledger permanently, so it cannot be reversed quietly later.`,
        ].join("\n"),
      };

    case "late_fee.paused":
      return {
        subject: `Late fees on your account are paused until ${payload.until}`,
        body: [
          `Hi ${first},`,
          ``,
          `Late fees on your account are paused until ${payload.until}.`,
          ``,
          `Why: ${payload.reason}`,
          ``,
          `You do not need to do anything about the pause itself.`,
        ].join("\n"),
      };

    case "payment_plan.opened":
      return {
        subject: `Your payment plan for ${money(payload.totalCents)}`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.openedByName ?? "Your property manager"} set up a payment plan for ${money(payload.totalCents)}.`,
          ``,
          `Schedule:`,
          ...(Array.isArray(payload.installments)
            ? (payload.installments as Array<{ dueDate: string; amountCents: number }>).map(
                (i, index) => `  ${index + 1}. ${money(i.amountCents)} due ${i.dueDate}`,
              )
            : []),
          ``,
          payload.suspendsLateFees
            ? `While you are following this plan, late fees will not be charged.`
            : `Late fees continue to apply under the property's normal policy.`,
          ``,
          `This plan is recorded on your ledger, where both you and the office can see it. Reason given: ${payload.reason}`,
        ].join("\n"),
      };

    case "payment_plan.installment_due":
      return {
        subject: `Plan installment of ${money(payload.amountCents)} due ${payload.dueDate}`,
        body: [
          `Hi ${first},`,
          ``,
          `Your next payment plan installment of ${money(payload.amountCents)} is due on ${payload.dueDate}.`,
          ``,
          `Installment ${payload.sequence} of ${payload.total}.`,
        ].join("\n"),
      };

    case "autopay.scheduled":
      return {
        subject: `Autopay will draft ${money(payload.amountCents)} on ${payload.draftDate}`,
        body: [
          `Hi ${first},`,
          ``,
          payload.isShare
            ? `Autopay is scheduled to draft your share of the rent, ${money(payload.amountCents)}, from ${payload.methodLabel} on ${payload.draftDate}.`
            : `Autopay is scheduled to draft ${money(payload.amountCents)} from ${payload.methodLabel} on ${payload.draftDate}.`,
          ``,
          `If that is not what you expect, you can change or cancel autopay from your account before that date.`,
        ].join("\n"),
      };

    case "autopay.blocked_by_cap":
      return {
        subject: `Autopay did not run — the amount is above your limit`,
        body: [
          `Hi ${first},`,
          ``,
          payload.isShare
            ? `Autopay did not draft your share this month. It is ${money(payload.balanceCents)}, which is above the ${money(payload.capCents)} limit you set on autopay.`
            : `Autopay did not draft this month. Your balance is ${money(payload.balanceCents)}, which is above the ${money(payload.capCents)} limit you set on autopay.`,
          ``,
          `Nothing was taken from your account. This is the limit working as intended — it exists so an unexpected charge cannot be drafted without you seeing it first.`,
          ``,
          `You can pay manually, or raise the limit, from your account.`,
        ].join("\n"),
      };

    case "workorder.submitted":
      return recipient.audience === "resident"
        ? {
            subject: `We received your maintenance request (${payload.reference})`,
            body: [
              `Hi ${first},`,
              ``,
              `Your request has been logged as ${payload.reference}.`,
              ``,
              `${payload.title}`,
              `Priority: ${payload.priority} — ${payload.priorityGuidance}`,
              ``,
              `You can follow it in your account. You will get an email whenever the status changes.`,
            ].join("\n"),
          }
        : {
            subject: `[${String(payload.priority).toUpperCase()}] ${payload.reference} — Unit ${payload.unitLabel}: ${payload.title}`,
            body: [
              `A maintenance request was filed.`,
              ``,
              `Unit: ${payload.unitLabel}`,
              `Resident: ${payload.residentName}`,
              `Priority: ${payload.priority} (target response ${payload.targetHours}h)`,
              `Entry permission: ${payload.entryPermission ? "granted" : "not granted"}`,
              ``,
              `${payload.description}`,
            ].join("\n"),
          };

    case "workorder.status_changed":
      return {
        subject: `${payload.reference}: ${payload.status}`,
        body: [
          `Hi ${first},`,
          ``,
          `Your maintenance request ${payload.reference} (${payload.title}) is now: ${payload.status}.`,
          payload.note ? `\nNote from the office: ${payload.note}` : "",
        ].join("\n"),
      };

    case "workorder.resolved":
      return {
        subject: `${payload.reference} has been resolved`,
        body: [
          `Hi ${first},`,
          ``,
          `Your maintenance request ${payload.reference} (${payload.title}) has been marked resolved.`,
          payload.note ? `\nWhat was done: ${payload.note}` : "",
          payload.creditCents
            ? `\nA credit of ${money(payload.creditCents)} has been applied to your account for this. It appears on your ledger linked to this request, so you can see what it was for.`
            : "",
          ``,
          `If the problem is not actually fixed, you can reopen this request from your account.`,
        ].join("\n"),
      };

    case "dispute.opened":
      return {
        subject: `Unit ${payload.unitLabel} disputed a charge of ${money(payload.amountCents)}`,
        body: [
          `${payload.residentName} in unit ${payload.unitLabel} has disputed a charge.`,
          ``,
          `Charge: ${payload.description} — ${money(payload.amountCents)}`,
          `Their reason: ${payload.reason}`,
          ``,
          `Late fees on this account are paused while the dispute is open.`,
        ].join("\n"),
      };

    case "dispute.responded":
      return {
        subject: `A response to your disputed charge`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.responderName ?? "Your property manager"} responded to the charge you disputed.`,
          ``,
          `Their response: ${payload.response}`,
          ``,
          payload.adjusted
            ? `The charge was adjusted by ${money(payload.adjustmentCents)}. Your balance is now ${money(payload.balanceCents)}.`
            : `The charge stands as originally posted. Your balance is unchanged at ${money(payload.balanceCents)}.`,
          ``,
          `The dispute and this response are attached to that charge on your ledger permanently.`,
        ].join("\n"),
      };

    case "message.to_resident":
      return {
        subject: `New message: ${payload.subject}`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.authorName ?? "Your property manager"} wrote:`,
          ``,
          String(payload.body ?? ""),
          ``,
          `Sign in and open Messages to reply. The conversation stays in your account.`,
        ].join("\n"),
      };

    case "message.to_management":
      return {
        subject: `Unit ${payload.unitLabel}: ${payload.subject}`,
        body: [
          `Hi ${first},`,
          ``,
          `${payload.authorName ?? "A resident"} (unit ${payload.unitLabel}) wrote:`,
          ``,
          String(payload.body ?? ""),
          ``,
          `Reply from Messages in the manager workspace.`,
        ].join("\n"),
      };

    case "payment.refunded":
      return {
        subject: `A refund of ${money(payload.amountCents)}`,
        body: [
          `Hi ${first},`,
          ``,
          `A refund of ${money(payload.amountCents)} has been issued. Depending on your bank it usually appears within a few business days.`,
        ].join("\n"),
      };

    default: {
      // Every event has a template above; this is the fallback for one added to
      // the catalog before its copy is written.
      const summary = EVENT_CATALOG[eventType as EventType].summary;
      return { subject: summary, body: `${summary}\n\n${JSON.stringify(payload, null, 2)}` };
    }
  }
}

/** SMS is reserved for failures. 160 characters, no links that need a login. */
function renderSms(eventType: EventType, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "payment.failed":
      return `Your rent payment of ${money(payment(payload))} did not go through. Nothing was taken. Late fees are paused until ${payload.feesPausedUntil}. Check your email or sign in for details.`;
    case "payment.returned":
      return `Your bank returned a rent payment of ${money(payment(payload))}. The amount is back on your balance. Late fees are paused until ${payload.feesPausedUntil}.`;
    default:
      return String(EVENT_CATALOG[eventType]?.summary ?? "Update on your account.");
  }
}

const payment = (payload: Record<string, unknown>) => payload.amountCents;

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

export interface Transport {
  readonly name: string;
  send(message: {
    channel: NotificationChannel;
    to: string;
    subject: string;
    body: string;
  }): Promise<void>;
}

/**
 * Send the pending queue.
 *
 * Retries with exponential backoff and gives up after six attempts, leaving the
 * row marked failed rather than retrying forever. A permanently-failing address
 * is a thing a manager should see in the queue, not something the system should
 * keep quietly attempting for a month.
 */
export async function dispatchPending(
  tx: Tx,
  transport: Transport,
  limit = 50,
): Promise<{ sent: number; failed: number }> {
  const pending = await tx.many<{
    id: string;
    channel: NotificationChannel;
    recipient: string;
    subject: string;
    body: string;
    attempts: number;
  }>(
    `SELECT id, channel, recipient, subject, body, attempts
     FROM notification_deliveries
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  let sent = 0;
  let failed = 0;

  for (const delivery of pending) {
    try {
      await transport.send({
        channel: delivery.channel,
        to: delivery.recipient,
        subject: delivery.subject,
        body: delivery.body,
      });
      await tx.query(
        "UPDATE notification_deliveries SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1",
        [delivery.id],
      );
      sent += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const giveUp = attempts >= 6;
      // 1m, 2m, 4m, 8m, 16m — long enough to ride out a transient mail outage.
      const backoffMinutes = Math.min(2 ** attempts, 60);
      await tx.query(
        `UPDATE notification_deliveries
         SET attempts = $2, last_error = $3,
             status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + ($5 || ' minutes')::interval
         WHERE id = $1`,
        [delivery.id, attempts, String((error as Error).message).slice(0, 480), giveUp, String(backoffMinutes)],
      );
      failed += 1;
    }
  }

  return { sent, failed };
}

export async function listForTenancy(tx: Tx, tenancyId: string, limit = 50) {
  return tx.many<{
    id: string;
    event_type: string;
    channel: string;
    subject: string;
    body: string;
    status: string;
    created_at: string;
    sent_at: string | null;
  }>(
    `SELECT d.id, e.event_type, d.channel, d.subject, d.body, d.status,
            d.created_at::text AS created_at, d.sent_at::text AS sent_at
     FROM notification_deliveries d
     JOIN notification_events e ON e.id = d.event_id
     WHERE d.tenancy_id = $1 AND d.audience = 'resident'
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [tenancyId, limit],
  );
}
