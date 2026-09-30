/**
 * The event catalog.
 *
 * Every ledger and work-order state change that a person needs to hear about
 * appears exactly once in this table, together with who hears it and on which
 * channel. Two properties matter and are tested rather than asserted:
 *
 *   Exactly once. Each event carries a deduplication key derived from what
 *   happened, not from when we noticed. A replayed provider webhook or a
 *   re-run job cannot send a resident four copies of the same late notice.
 *
 *   Specific content. Every template states the amount, the date, the reason,
 *   and what happens next. A notice that says "there was a problem with your
 *   payment" and stops is what sends a worried person to the phone, which is the
 *   friction this project is supposed to remove rather than relocate.
 */

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_AUDIENCES = ["resident", "manager", "staff"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const EVENT_TYPES = [
  "charge.posted",
  "charge.upcoming",
  "payment.receipt",
  "payment.failed",
  "payment.returned",
  "payment.refunded",
  "balance.past_due",
  "late_fee.assessed",
  "late_fee.waived",
  "late_fee.paused",
  "payment_plan.opened",
  "payment_plan.installment_due",
  "autopay.scheduled",
  "autopay.blocked_by_cap",
  "workorder.submitted",
  "workorder.status_changed",
  "workorder.resolved",
  "dispute.opened",
  "dispute.responded",
  "message.to_resident",
  "message.to_management",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventDefinition {
  type: EventType;
  audiences: readonly NotificationAudience[];
  channels: readonly NotificationChannel[];
  /** Sent even if the recipient has muted routine mail. Failures and money only. */
  critical: boolean;
  summary: string;
}

export const EVENT_CATALOG: Record<EventType, EventDefinition> = {
  "charge.posted": {
    type: "charge.posted",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "A new charge was added to the ledger.",
  },
  "charge.upcoming": {
    type: "charge.upcoming",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "Rent is due in a few days; states the amount and the date.",
  },
  "payment.receipt": {
    type: "payment.receipt",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "A payment settled. Carries the receipt number and the new balance.",
  },
  "payment.failed": {
    type: "payment.failed",
    audiences: ["resident", "manager"],
    channels: ["email", "sms"],
    critical: true,
    summary: "A payment did not go through. States why, and that fees are paused.",
  },
  "payment.returned": {
    type: "payment.returned",
    audiences: ["resident", "manager"],
    channels: ["email", "sms"],
    critical: true,
    summary: "A settled ACH payment was returned by the bank days later.",
  },
  "payment.refunded": {
    type: "payment.refunded",
    audiences: ["resident", "manager"],
    channels: ["email"],
    critical: true,
    summary: "A payment was refunded to the resident.",
  },
  "balance.past_due": {
    type: "balance.past_due",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "A balance passed its grace period. States the amount and the options.",
  },
  "late_fee.assessed": {
    type: "late_fee.assessed",
    audiences: ["resident", "manager"],
    channels: ["email"],
    critical: true,
    summary: "A late fee posted under the property's configured policy.",
  },
  "late_fee.waived": {
    type: "late_fee.waived",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "A manager waived a fee. Carries the reason they gave.",
  },
  "late_fee.paused": {
    type: "late_fee.paused",
    audiences: ["resident", "manager"],
    channels: ["email"],
    critical: true,
    summary: "Fee accrual was suspended because a payment failed on the bank's side.",
  },
  "payment_plan.opened": {
    type: "payment_plan.opened",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "A payment plan was opened. Lists every installment and date.",
  },
  "payment_plan.installment_due": {
    type: "payment_plan.installment_due",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "A plan installment comes due in three days.",
  },
  "autopay.scheduled": {
    type: "autopay.scheduled",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "Autopay will draft a stated amount on a stated date.",
  },
  "autopay.blocked_by_cap": {
    type: "autopay.blocked_by_cap",
    audiences: ["resident", "manager"],
    channels: ["email"],
    critical: true,
    summary: "Autopay did not draft because the balance exceeded the resident's cap.",
  },
  "workorder.submitted": {
    type: "workorder.submitted",
    audiences: ["resident", "staff"],
    channels: ["email"],
    critical: false,
    summary: "A maintenance request was filed.",
  },
  "workorder.status_changed": {
    type: "workorder.status_changed",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "A request moved to a new status.",
  },
  "workorder.resolved": {
    type: "workorder.resolved",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "A request was resolved, including any rent credit that was posted.",
  },
  "dispute.opened": {
    type: "dispute.opened",
    audiences: ["manager"],
    channels: ["email"],
    critical: true,
    summary: "A resident disputed a specific charge.",
  },
  "dispute.responded": {
    type: "dispute.responded",
    audiences: ["resident"],
    channels: ["email"],
    critical: true,
    summary: "A manager answered a dispute; the answer attaches to the charge.",
  },
  "message.to_resident": {
    type: "message.to_resident",
    audiences: ["resident"],
    channels: ["email"],
    critical: false,
    summary: "Management wrote in a conversation with the resident.",
  },
  "message.to_management": {
    type: "message.to_management",
    audiences: ["manager"],
    channels: ["email"],
    critical: false,
    summary: "A resident wrote in a conversation with management.",
  },
};

export interface NotificationRecord {
  id: string;
  eventType: EventType;
  audience: NotificationAudience;
  channel: NotificationChannel;
  recipient: string;
  subject: string;
  body: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
