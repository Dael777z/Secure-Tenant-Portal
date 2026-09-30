/**
 * The API contract.
 *
 * These schemas are imported by the server, which validates every request
 * against them at the boundary, and by the browser client, which builds requests
 * from the same definitions. There is no second copy of the shape of a money
 * field to drift out of agreement with this one.
 */

import * as v from "./validate.ts";
import type { Cents } from "./money.ts";
import type { Uuid, PeriodKey } from "./ids.ts";
import type { LedgerEntry, PeriodSummary, AgingBuckets } from "./ledger.ts";
import { ENTRY_CATEGORIES } from "./ledger.ts";
import type {
  Payment,
  PaymentMethodSummary,
  AutopayEnrollment,
  PaymentPlan,
  PaymentStatus,
} from "./payments.ts";
import { PAYMENT_METHODS } from "./payments.ts";
import type { WorkOrder, ChargeDispute } from "./maintenance.ts";
import { WORK_ORDER_CATEGORIES, WORK_ORDER_PRIORITIES, WORK_ORDER_STATUSES } from "./maintenance.ts";
import type { Role } from "./roles.ts";

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

export const loginRequest = v.object({
  email: v.email(),
  password: v.string().refine((s) => s.length >= 1, "password is required"),
});
export type LoginRequest = v.Infer<typeof loginRequest>;

/** Self-service reset (020): ask for a link. */
export const forgotPasswordRequest = v.object({
  email: v.email(),
});
export type ForgotPasswordRequest = v.Infer<typeof forgotPasswordRequest>;

export const resetTokenRequest = v.object({
  token: v.string().refine((s) => s.length >= 20 && s.length <= 200, "that link is not complete"),
});

export const resetPasswordRequest = v.object({
  token: v.string().refine((s) => s.length >= 20 && s.length <= 200, "that link is not complete"),
  newPassword: v.string().refine((s) => s.length >= 12, "must be at least 12 characters"),
});
export type ResetPasswordRequest = v.Infer<typeof resetPasswordRequest>;

export const changePasswordRequest = v.object({
  currentPassword: v.string().refine((s) => s.length >= 1, "current password is required"),
  // 12 characters, and nothing else. Composition rules push people toward
  // "Password1!" and away from length, which is the property that actually
  // matters. NIST SP 800-63B has said so since 2017.
  newPassword: v.string().refine((s) => s.length >= 12, "must be at least 12 characters"),
});
export type ChangePasswordRequest = v.Infer<typeof changePasswordRequest>;

export interface SessionUser {
  id: Uuid;
  email: string;
  displayName: string;
  role: Role;
  organizationId: Uuid;
  organizationName: string;
  /** Present for residents: the tenancy the session reads. */
  tenancyId: Uuid | null;
  unitLabel: string | null;
  propertyName: string | null;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  user: SessionUser;
  expiresAt: string;
}

/* ------------------------------------------------------------------ *
 * Resident — ledger and balance
 * ------------------------------------------------------------------ */

export const ledgerQuery = v.object({
  period: v.periodKey().optional(),
  from: v.isoDate().optional(),
  to: v.isoDate().optional(),
  limit: v.numericString().refine((n) => n > 0 && n <= 500, "limit must be 1–500").default(200),
});
export type LedgerQuery = v.Infer<typeof ledgerQuery>;

export interface BalanceSummary {
  tenancyId: Uuid;
  balanceCents: Cents;
  aging: AgingBuckets;
  /** The next scheduled charge, so the resident is not surprised by it. */
  nextChargeDate: string | null;
  nextChargeCents: Cents | null;
  dueDate: string | null;
  /** Null when the property has no late-fee policy enabled, which is the default. */
  lateFeeStartsOn: string | null;
  lateFeesPausedUntil: string | null;
  lateFeePauseReason: string | null;
  activePlan: PaymentPlan | null;
  autopay: AutopayEnrollment | null;
  /** Every autopay on the lease (021): the whole balance, or each resident's share. */
  leaseAutopays?: AutopayEnrollment[];
  pendingPayments: Payment[];
}

export interface TenantSummaryResponse {
  balance: BalanceSummary;
  recentEntries: LedgerEntry[];
  openWorkOrders: WorkOrder[];
  openDisputes: ChargeDispute[];
  paymentMethods: PaymentMethodSummary[];
  /** False when the property takes bank transfers only (PAYMENTS_ALLOW_CARDS unset). */
  cardsAccepted: boolean;
}

export interface LedgerResponse {
  entries: LedgerEntry[];
  periods: PeriodSummary[];
  balanceCents: Cents;
}

/**
 * Everything that produced one ledger row, assembled so that the resident can
 * follow a number back to its cause without asking anyone. This endpoint is the
 * concrete form of the claim that a disputed charge can be reconstructed months
 * later by either party from the same source of truth.
 */
export interface EntryTraceResponse {
  entry: LedgerEntry;
  reversedBy: LedgerEntry | null;
  reverses: LedgerEntry | null;
  payment: Payment | null;
  workOrder: WorkOrder | null;
  plan: PaymentPlan | null;
  dispute: ChargeDispute | null;
  /** The policy row that authorized an automatic fee, if this row is one. */
  policyExplanation: string | null;
  relatedEntries: LedgerEntry[];
}

/* ------------------------------------------------------------------ *
 * Resident — payments
 * ------------------------------------------------------------------ */

export const submitPaymentRequest = v.object({
  amountCents: v.integer().refine((n) => n > 0, "amount must be positive")
    .refine((n) => n <= 5_000_00, "amounts over $5,000 must be arranged with the office"),
  paymentMethodId: v.uuid(),
  /**
   * The resident states what they believe they owe. If the ledger disagrees the
   * server refuses rather than charging a different number than the screen
   * showed — a stale tab must never become an unexpected debit.
   */
  expectedBalanceCents: v.integer().optional(),
});
export type SubmitPaymentRequest = v.Infer<typeof submitPaymentRequest>;

export interface SubmitPaymentResponse {
  payment: Payment;
  balanceCents: Cents;
  /** True when this request matched an earlier one and no second charge was made. */
  deduplicated: boolean;
}

export const addPaymentMethodRequest = v.object({
  kind: v.enumOf(["ach", "card"] as const),
  /**
   * A token from the payment provider's client-side element. Raw card numbers
   * and full account numbers never reach this server, which is what keeps the
   * self-hosted deployment out of PCI scope beyond SAQ-A.
   */
  providerToken: v.nonEmptyString(255),
  makeAutopayDefault: v.boolean().default(false),
});
export type AddPaymentMethodRequest = v.Infer<typeof addPaymentMethodRequest>;

export const verifyBankRequest = v.object({
  /** The two deposit amounts, in cents (1–99 each), in either order. */
  amountsCents: v.array(v.integer().refine((n) => n >= 1 && n <= 99, "each deposit is between 1 and 99 cents")).refine(
    (a) => a.length === 2,
    "enter both deposit amounts",
  ),
});

export const autopayRequest = v.object({
  paymentMethodId: v.uuid(),
  dayOfMonth: v.integer().refine((n) => n >= 1 && n <= 28, "pick a day from 1 to 28"),
  capCents: v.integer().refine((n) => n > 0, "a cap must be positive").nullable().default(null),
  /** Split rent (021): this person's share each month. Null or absent: the whole balance. */
  shareCents: v.integer().refine((n) => n > 0, "a share must be more than $0").nullable().default(null),
});
export type AutopayRequest = v.Infer<typeof autopayRequest>;

/* ------------------------------------------------------------------ *
 * Resident — disputes and maintenance
 * ------------------------------------------------------------------ */

export const openDisputeRequest = v.object({
  ledgerEntryId: v.uuid(),
  reason: v.string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 10, "please describe the problem in a sentence or two")
    .refine((s) => s.length <= 2000, "must be 2000 characters or fewer"),
});
export type OpenDisputeRequest = v.Infer<typeof openDisputeRequest>;

export const submitWorkOrderRequest = v.object({
  category: v.enumOf(WORK_ORDER_CATEGORIES),
  priority: v.enumOf(WORK_ORDER_PRIORITIES),
  title: v.nonEmptyString(140),
  description: v.string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 10, "please describe the problem")
    .refine((s) => s.length <= 4000, "must be 4000 characters or fewer"),
  entryPermission: v.boolean().default(false),
});
export type SubmitWorkOrderRequest = v.Infer<typeof submitWorkOrderRequest>;

/** A manager or on-site staff member filing a request on a resident's behalf (a phone call, a walk-through). */
export const managerSubmitWorkOrderRequest = v.object({
  tenancyId: v.uuid(),
  category: v.enumOf(WORK_ORDER_CATEGORIES),
  priority: v.enumOf(WORK_ORDER_PRIORITIES),
  title: v.nonEmptyString(140),
  description: v.string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 10, "please describe the problem")
    .refine((s) => s.length <= 4000, "must be 4000 characters or fewer"),
  entryPermission: v.boolean().default(false),
});
export type ManagerSubmitWorkOrderRequest = v.Infer<typeof managerSubmitWorkOrderRequest>;

export const workOrderNoteRequest = v.object({
  note: v.nonEmptyString(2000),
});
export type WorkOrderNoteRequest = v.Infer<typeof workOrderNoteRequest>;

/* ------------------------------------------------------------------ *
 * Manager — rent roll and exceptions
 * ------------------------------------------------------------------ */

export const rentRollQuery = v.object({
  period: v.periodKey().optional(),
  propertyId: v.uuid().optional(),
  status: v.enumOf(["all", "paid", "partial", "unpaid", "failed", "credit"] as const).default("all"),
  search: v.boundedText(120).optional(),
  limit: v.numericString().refine((n) => n > 0 && n <= 1000, "limit must be 1–1000").default(500),
  offset: v.numericString().refine((n) => n >= 0, "offset must not be negative").default(0),
});
export type RentRollQuery = v.Infer<typeof rentRollQuery>;

export type RentRollStatus = "paid" | "partial" | "unpaid" | "failed" | "credit";

export interface RentRollRow {
  tenancyId: Uuid;
  unitLabel: string;
  propertyName: string;
  residentName: string;
  residentEmail: string;
  /** The lease rent, before fees and credits — the rent roll's "Market Rent" column. */
  monthlyRentCents: Cents;
  /** When this period's rent falls due (YYYY-MM-DD), from the lease's due day. */
  dueDate: string;
  chargedCents: Cents;
  paidCents: Cents;
  dueCents: Cents;
  balanceCents: Cents;
  status: RentRollStatus;
  lastPaymentDate: string | null;
  lastPaymentStatus: PaymentStatus | null;
  hasActivePlan: boolean;
  lateFeesPaused: boolean;
  openDisputes: number;
  daysPastDue: number;
}

export interface RentRollResponse {
  period: PeriodKey;
  rows: RentRollRow[];
  totals: {
    units: number;
    chargedCents: Cents;
    collectedCents: Cents;
    outstandingCents: Cents;
    collectionRate: number;
  };
  total: number;
  generatedInMs: number;
}

/**
 * The manager dashboard: the portfolio at a glance.
 *
 * Every figure is computed live from the same ledger and work-order rows the
 * other screens read, under the caller's Row-Level Security scope. There is no
 * summary table to drift out of step with the rent roll.
 */
export const dashboardQuery = v.object({
  period: v.periodKey().optional(),
  propertyId: v.uuid().optional(),
});
export type DashboardQuery = v.Infer<typeof dashboardQuery>;

export type ActivityKind =
  | "payment_received"
  | "payment_failed"
  | "payment_pending"
  | "workorder_submitted"
  | "workorder_completed"
  | "lease_started";

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  /** "Olivia Brown · Unit 1A · $1,500.00" — one line, readable without context. */
  detail: string;
  at: string;
  tenancyId: Uuid | null;
  workOrderId: Uuid | null;
}

export interface DashboardResponse {
  period: PeriodKey;
  portfolio: {
    properties: number;
    units: number;
    occupied: number;
    vacant: number;
  };
  rent: {
    expectedCents: Cents;
    collectedCents: Cents;
    outstandingCents: Cents;
    collectionRate: number;
    overdueAccounts: number;
    /** Exceptions a manager should look at (failed, returned, disputed, missed plan). */
    needsReview: number;
  };
  /** Null for roles that cannot read maintenance (owners). */
  maintenance: {
    open: number;
    /** Open emergencies — "High" in the manager workspace's priority labels. */
    highPriority: number;
    inProgress: number;
    completedThisPeriod: number;
  } | null;
  activity: ActivityItem[];
  /** Conversations with a message the caller has not read. Null for roles without messages (owners). */
  unreadMessages: number | null;
  generatedInMs: number;
}

/**
 * The exception queue. A manager's month-end problem is not viewing two hundred
 * rows; it is finding the four that need a person. Severity ordering here is the
 * product, so it is data rather than a sort the client invents.
 */
export const EXCEPTION_KINDS = [
  "payment_failed",
  "payment_returned",
  "dispute_open",
  "plan_missed",
  "autopay_blocked",
  "severely_past_due",
  "past_due",
  "partial_payment",
  "unapplied_credit",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_SEVERITY: Record<ExceptionKind, number> = {
  payment_returned: 100,
  payment_failed: 90,
  dispute_open: 80,
  autopay_blocked: 70,
  plan_missed: 60,
  severely_past_due: 50,
  past_due: 30,
  partial_payment: 20,
  unapplied_credit: 10,
};

export const EXCEPTION_LABELS: Record<ExceptionKind, string> = {
  payment_returned: "Payment returned by bank",
  payment_failed: "Payment failed",
  dispute_open: "Charge disputed",
  autopay_blocked: "Autopay blocked by resident cap",
  plan_missed: "Payment plan installment missed",
  severely_past_due: "Past due over 30 days",
  past_due: "Past due",
  partial_payment: "Paid short",
  unapplied_credit: "Credit on account",
};

export interface ExceptionRow {
  kind: ExceptionKind;
  severity: number;
  tenancyId: Uuid;
  unitLabel: string;
  propertyName: string;
  residentName: string;
  amountCents: Cents;
  /** One sentence a manager can act on without opening anything else. */
  detail: string;
  occurredAt: string;
  paymentId: Uuid | null;
  disputeId: Uuid | null;
  ledgerEntryId: Uuid | null;
  /** Actions the system offers for this exception, in the order they make sense. */
  suggestedActions: readonly string[];
}

export interface ExceptionsResponse {
  period: PeriodKey;
  rows: ExceptionRow[];
  countsByKind: Record<string, number>;
  generatedInMs: number;
}

/* ------------------------------------------------------------------ *
 * Manager — discretionary actions
 *
 * Every one of these appends to the ledger with an actor and a reason. None of
 * them updates or deletes anything. The reason is required by the schema, not by
 * a convention someone can skip on a busy day.
 * ------------------------------------------------------------------ */

export const waiveFeeRequest = v.object({
  ledgerEntryId: v.uuid(),
  reason: v.actionReason(),
  /** Omit to waive the whole fee; supply a smaller amount to waive part of it. */
  amountCents: v.integer().refine((n) => n > 0, "amount must be positive").optional(),
});
export type WaiveFeeRequest = v.Infer<typeof waiveFeeRequest>;

export const recordPaymentRequest = v.object({
  tenancyId: v.uuid(),
  amountCents: v.integer().refine((n) => n > 0, "amount must be positive"),
  method: v.enumOf(["check", "cash", "money_order"] as const),
  receivedOn: v.isoDate(),
  reference: v.boundedText(120).optional(),
  reason: v.actionReason(),
});
export type RecordPaymentRequest = v.Infer<typeof recordPaymentRequest>;

export const adjustmentRequest = v.object({
  tenancyId: v.uuid(),
  category: v.enumOf(ENTRY_CATEGORIES),
  /** Signed. A credit to the resident is negative, a charge is positive. */
  amountCents: v.integer().refine((n) => n !== 0, "an adjustment of zero does nothing"),
  description: v.nonEmptyString(300),
  effectiveDate: v.isoDate().optional(),
  reason: v.actionReason(),
});
export type AdjustmentRequest = v.Infer<typeof adjustmentRequest>;

export const reverseEntryRequest = v.object({
  ledgerEntryId: v.uuid(),
  reason: v.actionReason(),
});
export type ReverseEntryRequest = v.Infer<typeof reverseEntryRequest>;

export const paymentPlanRequest = v.object({
  tenancyId: v.uuid(),
  totalCents: v.integer().refine((n) => n > 0, "amount must be positive"),
  installments: v.integer().refine((n) => n >= 2 && n <= 12, "a plan runs 2 to 12 installments"),
  firstDueDate: v.isoDate(),
  intervalDays: v.integer().refine((n) => n >= 7 && n <= 31, "installments fall 7 to 31 days apart").default(30),
  reason: v.actionReason(),
  /** Default true: the point of a plan is that following it does not accrue fees. */
  suspendLateFees: v.boolean().default(true),
});
export type PaymentPlanRequest = v.Infer<typeof paymentPlanRequest>;

export const respondToDisputeRequest = v.object({
  disputeId: v.uuid(),
  response: v.string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 10, "the resident needs an actual answer")
    .refine((s) => s.length <= 4000, "must be 4000 characters or fewer"),
  resolution: v.enumOf(["upheld", "adjusted", "responded"] as const),
  /** Required when resolution is "adjusted": the correcting amount, signed. */
  adjustmentCents: v.integer().optional(),
});
export type RespondToDisputeRequest = v.Infer<typeof respondToDisputeRequest>;

export const postChargesRequest = v.object({
  period: v.periodKey(),
  propertyId: v.uuid().optional(),
  /** Preview first. Posting is idempotent, but a manager should still see it first. */
  dryRun: v.boolean().default(true),
});
export type PostChargesRequest = v.Infer<typeof postChargesRequest>;

export interface PostChargesResponse {
  period: PeriodKey;
  dryRun: boolean;
  posted: Array<{
    tenancyId: Uuid;
    unitLabel: string;
    residentName: string;
    category: string;
    amountCents: Cents;
    description: string;
    alreadyPosted: boolean;
  }>;
  totalCents: Cents;
  newCount: number;
  skippedCount: number;
}

export const updateWorkOrderRequest = v.object({
  status: v.enumOf(WORK_ORDER_STATUSES).optional(),
  note: v.boundedText(2000).optional(),
  visibleToResident: v.boolean().default(true),
  assignedToUserId: v.uuid().nullable().optional(),
  /** Resolving a request can post a rent credit linked to it. */
  creditCents: v.integer().refine((n) => n > 0, "a credit must be positive").optional(),
  creditReason: v.boundedText(300).optional(),
});
export type UpdateWorkOrderRequest = v.Infer<typeof updateWorkOrderRequest>;

export const lateFeePolicyRequest = v.object({
  propertyId: v.uuid(),
  /** Off by default. Escalation is a policy a manager turns on, not a default. */
  enabled: v.boolean(),
  graceDays: v.integer().refine((n) => n >= 0 && n <= 30, "grace is 0 to 30 days"),
  feeType: v.enumOf(["flat", "percent"] as const),
  flatCents: v.integer().refine((n) => n >= 0, "must not be negative").default(0),
  percent: v.number().refine((n) => n >= 0 && n <= 25, "percent must be 0 to 25").default(0),
  dailyCents: v.integer().refine((n) => n >= 0, "must not be negative").default(0),
  maxCents: v.integer().refine((n) => n >= 0, "must not be negative").default(0),
  minBalanceCents: v.integer().refine((n) => n >= 0, "must not be negative").default(0),
});
export type LateFeePolicyRequest = v.Infer<typeof lateFeePolicyRequest>;

export interface LateFeePolicy {
  propertyId: Uuid;
  propertyName: string;
  enabled: boolean;
  graceDays: number;
  feeType: "flat" | "percent";
  flatCents: Cents;
  percent: number;
  dailyCents: Cents;
  maxCents: Cents;
  minBalanceCents: Cents;
  updatedAt: string | null;
  updatedByName: string | null;
  /** The policy stated as one sentence, shown to residents on their ledger. */
  plainLanguage: string;
}

export const exportQuery = v.object({
  period: v.periodKey(),
  propertyId: v.uuid().optional(),
  format: v.enumOf(["csv", "json"] as const).default("csv"),
  audience: v.enumOf(["accountant", "owner", "legal"] as const).default("accountant"),
});
export type ExportQuery = v.Infer<typeof exportQuery>;

/* ------------------------------------------------------------------ *
 * Messages (migration 011) — resident ↔ management conversations
 * ------------------------------------------------------------------ */

export const MESSAGE_TOPICS = ["general", "payment", "maintenance", "lease", "other"] as const;
export type MessageTopic = (typeof MESSAGE_TOPICS)[number];

export const MESSAGE_TOPIC_LABELS: Record<MessageTopic, string> = {
  general: "General question",
  payment: "Rent or a charge",
  maintenance: "Maintenance",
  lease: "Lease or documents",
  other: "Something else",
};

export interface MessageThread {
  id: Uuid;
  tenancyId: Uuid;
  propertyId: Uuid;
  propertyName: string;
  unitLabel: string;
  /** Null when the reader cannot see the resident's user row (a resident reading their own thread sees their own name). */
  residentName: string | null;
  subject: string;
  topic: MessageTopic;
  status: "open" | "closed";
  ledgerEntryId: Uuid | null;
  workOrderId: Uuid | null;
  startedBy: "resident" | "management";
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastAuthorName: string | null;
  lastFromResident: boolean;
}

export interface Message {
  id: Uuid;
  authorName: string;
  authorRole: string;
  fromResident: boolean;
  /** True when the reader wrote it. */
  mine: boolean;
  body: string;
  createdAt: string;
}

export const startThreadRequest = v.object({
  /** Management only: which resident. Residents always write about their own tenancy. */
  tenancyId: v.uuid().optional(),
  subject: v.nonEmptyString(140),
  topic: v.enumOf(MESSAGE_TOPICS).default("general"),
  body: v.nonEmptyString(4000),
  ledgerEntryId: v.uuid().optional(),
  workOrderId: v.uuid().optional(),
});
export type StartThreadRequest = v.Infer<typeof startThreadRequest>;

export const postMessageRequest = v.object({
  body: v.nonEmptyString(4000),
});
export type PostMessageRequest = v.Infer<typeof postMessageRequest>;

export const threadStatusRequest = v.object({
  status: v.enumOf(["open", "closed"] as const),
});

/* ------------------------------------------------------------------ *
 * Units and tenants directories (manager workspace)
 * ------------------------------------------------------------------ */

export interface UnitRow {
  unitId: Uuid;
  propertyId: Uuid;
  propertyName: string;
  label: string;
  bedrooms: number | null;
  marketRentCents: Cents;
  occupied: boolean;
  tenancyId: Uuid | null;
  residentName: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  leaseRentCents: Cents | null;
  balanceCents: Cents | null;
  openWorkOrders: number;
}

export interface TenantRow {
  tenancyId: Uuid;
  userId: Uuid;
  name: string;
  email: string;
  phone: string | null;
  propertyName: string;
  unitLabel: string;
  status: string;
  leaseStart: string;
  leaseEnd: string | null;
  monthlyRentCents: Cents;
  balanceCents: Cents;
  autopay: boolean;
  lastSignIn: string | null;
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

export interface ApiError {
  error: {
    code: string;
    message: string;
    issues?: Array<{ path: string; message: string }>;
    requestId?: string;
  };
}

export const PAYMENT_METHOD_KINDS = PAYMENT_METHODS;
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const CSRF_HEADER = "x-portal-csrf";
export const REQUEST_ID_HEADER = "x-request-id";
