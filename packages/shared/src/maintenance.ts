import type { Cents } from "./money.ts";
import type { Uuid } from "./ids.ts";

/**
 * Maintenance intake lives with notifications rather than standing alone,
 * because its most valuable property is its connection to the ledger: a request
 * resolved in a way that warrants a rent credit posts that credit as a linked
 * row, so the resident sees the money and its cause in one place instead of
 * finding an unexplained credit and wondering whether it is a mistake.
 */

export const WORK_ORDER_STATUSES = [
  "submitted",
  "acknowledged",
  "scheduled",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const OPEN_STATUSES: readonly WorkOrderStatus[] = [
  "submitted",
  "acknowledged",
  "scheduled",
  "in_progress",
];

const WO_TRANSITIONS: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  submitted: ["acknowledged", "scheduled", "in_progress", "resolved", "cancelled"],
  acknowledged: ["scheduled", "in_progress", "resolved", "cancelled"],
  scheduled: ["in_progress", "resolved", "cancelled"],
  in_progress: ["resolved", "scheduled", "cancelled"],
  // A resident who says the problem is not actually fixed can reopen it, which
  // is the difference between a request queue that reflects reality and one that
  // reflects what staff clicked.
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
  cancelled: [],
};

export function canTransitionWorkOrder(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return WO_TRANSITIONS[from].includes(to);
}

export const WORK_ORDER_CATEGORIES = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "pest",
  "locks_keys",
  "structural",
  "common_area",
  "other",
] as const;
export type WorkOrderCategory = (typeof WORK_ORDER_CATEGORIES)[number];

export const WORK_ORDER_PRIORITIES = ["emergency", "urgent", "routine"] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const PRIORITY_TARGET_HOURS: Record<WorkOrderPriority, number> = {
  emergency: 4,
  urgent: 24,
  routine: 120,
};

export const PRIORITY_GUIDANCE: Record<WorkOrderPriority, string> = {
  emergency: "No heat, no water, flooding, gas smell, or anything unsafe. Someone responds within 4 hours.",
  urgent: "A appliance or fixture you rely on daily has stopped working. Response within 1 business day.",
  routine: "Everything still works, but something needs attention. Response within 5 business days.",
};

export interface WorkOrderPhoto {
  id: Uuid;
  /** A signed URL that expires; the object itself is never publicly readable. */
  url: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface WorkOrderEvent {
  id: Uuid;
  at: string;
  kind: "status" | "note" | "photo" | "credit";
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus | null;
  note: string | null;
  authorName: string | null;
  authorRole: string | null;
  /** Internal notes never reach the resident's thread. */
  visibleToResident: boolean;
  linkedLedgerEntryId: Uuid | null;
}

export interface WorkOrder {
  id: Uuid;
  reference: string;
  tenancyId: Uuid;
  unitLabel: string;
  propertyName: string;
  category: WorkOrderCategory;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  title: string;
  description: string;
  entryPermission: boolean;
  submittedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  assignedToName: string | null;
  residentName: string | null;
  photos: WorkOrderPhoto[];
  events: WorkOrderEvent[];
  /** A credit posted as part of resolving this request, if any. */
  creditCents: Cents | null;
  creditLedgerEntryId: Uuid | null;
}

export const DISPUTE_STATUSES = [
  "open",
  "responded",
  "resolved_adjusted",
  "resolved_upheld",
  "withdrawn",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export interface ChargeDispute {
  id: Uuid;
  ledgerEntryId: Uuid;
  tenancyId: Uuid;
  status: DisputeStatus;
  reason: string;
  openedAt: string;
  openedByName: string | null;
  response: string | null;
  respondedAt: string | null;
  respondedByName: string | null;
  /** Set when the manager resolved the dispute by appending a correcting row. */
  resolutionEntryId: Uuid | null;
}
