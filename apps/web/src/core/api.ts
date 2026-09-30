/**
 * The API client.
 *
 * It imports its types from `packages/shared`, the same module the server
 * imports, which is what makes it impossible for the client and the API to
 * disagree about the shape of a money field. The server serves that directory
 * at `/shared/`, type-stripped, so there is one definition and no build step
 * keeping two copies in sync.
 */

import type {
  BalanceSummary,
  DashboardResponse,
  Message,
  MessageThread,
  TenantRow,
  UnitRow,
  EntryTraceResponse,
  ExceptionsResponse,
  LedgerResponse,
  RentRollResponse,
  SessionUser,
} from "/shared/api.js";
import type { LedgerEntry } from "/shared/ledger.js";
import type { AutopayEnrollment, Payment, PaymentMethodSummary, PaymentPlan } from "/shared/payments.js";
import type { ChargeDispute, WorkOrder } from "/shared/maintenance.js";
import type { Capability, Role } from "/shared/roles.js";
import type {
  ImportKind,
  ImportReport,
  IssuedLogin,
  LateFeeTerms,
  LeaseDocument,
  LeaseResident,
  RecurringCharge,
  ResidentContact,
  ScreeningSettings,
} from "/shared/portfolio.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: Array<{ path: string; message: string }>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    issues: Array<{ path: string; message: string }> = [],
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.requestId = requestId;
  }

  /** Field-level messages, keyed by path, for rendering next to inputs. */
  get byField(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) out[issue.path] = issue.message;
    return out;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Required on payments; the server refuses a payment without one. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-portal-csrf"] = csrfToken;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    // The session is an HttpOnly cookie: not readable from here, which is the
    // point. It travels because of this, not because the client holds it.
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) {
      throw new ApiError(response.status, "unexpected_response", "The server returned an unexpected response.");
    }
    return (await response.text()) as T;
  }

  const payload = await response.json();

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? "error",
      error.message ?? "Something went wrong.",
      error.issues ?? [],
      error.requestId,
    );
  }

  return payload as T;
}

const query = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

export interface MeResponse {
  user: SessionUser | null;
  csrfToken: string | null;
  expiresAt?: string;
  capabilities?: Capability[];
  roleLabel?: string;
  roleDescription?: string;
}

export const auth = {
  me: () => request<MeResponse>("/api/v1/auth/me"),

  async login(email: string, password: string): Promise<MeResponse> {
    const result = await request<{ user: SessionUser; csrfToken: string; expiresAt: string }>(
      "/api/v1/auth/login",
      { method: "POST", body: { email, password } },
    );
    setCsrfToken(result.csrfToken);
    return result;
  },

  async logout(): Promise<void> {
    await request("/api/v1/auth/logout", { method: "POST" });
    setCsrfToken(null);
  },

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>("/api/v1/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),

  /** Self-service reset (020). The answer is the same whether or not the address has an account. */
  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>("/api/v1/auth/forgot-password", { method: "POST", body: { email } }),

  checkResetToken: (token: string) =>
    request<{ valid: boolean }>("/api/v1/auth/reset-password/check", { method: "POST", body: { token } }),

  /** Use a reset link. Signs the person in, as a successful sign-in does. */
  async resetPassword(token: string, newPassword: string): Promise<MeResponse> {
    const result = await request<{ user: SessionUser; csrfToken: string; expiresAt: string }>(
      "/api/v1/auth/reset-password",
      { method: "POST", body: { token, newPassword } },
    );
    setCsrfToken(result.csrfToken);
    return result;
  },
};

/* ------------------------------------------------------------------ *
 * Resident
 * ------------------------------------------------------------------ */

export interface TenantSummary {
  balance: BalanceSummary & { lateFeePolicy: string };
  recentEntries: LedgerEntry[];
  openWorkOrders: WorkOrder[];
  openDisputes: ChargeDispute[];
  paymentMethods: PaymentMethodSummary[];
  /** False when the property takes bank transfers only. */
  cardsAccepted: boolean;
  /** Everyone on the lease, when there is more than one person on it. */
  leaseMembers: Array<{ userId: string; name: string; isPrimary: boolean }>;
  /** Lease documents waiting for this resident's signature. */
  documentsToSign: number;
  /** A photo of their unit, or else their building, if the office added one. */
  homePhotoId: string | null;
}

/**
 * Messages (migration 011). One client for both sides: `side` picks the
 * resident or the management endpoints, which return the same shapes.
 */
export const messages = {
  list: (side: "tenant" | "manager", params: { status?: string; propertyId?: string; tenancyId?: string; unread?: string } = {}) =>
    request<{ threads: MessageThread[] }>(`/api/v1/${side}/messages${query(params)}`),

  get: (side: "tenant" | "manager", threadId: string) =>
    request<{ thread: MessageThread; messages: Message[] }>(`/api/v1/${side}/messages/${threadId}`),

  start: (
    side: "tenant" | "manager",
    input: { tenancyId?: string; subject: string; topic: string; body: string; ledgerEntryId?: string; workOrderId?: string },
  ) => request<{ thread: MessageThread; messages: Message[] }>(`/api/v1/${side}/messages`, { method: "POST", body: input }),

  reply: (side: "tenant" | "manager", threadId: string, body: string) =>
    request<{ message: Message }>(`/api/v1/${side}/messages/${threadId}`, { method: "POST", body: { body } }),

  setStatus: (side: "tenant" | "manager", threadId: string, status: "open" | "closed") =>
    request<{ thread: MessageThread; messages: Message[] }>(`/api/v1/${side}/messages/${threadId}/status`, {
      method: "POST",
      body: { status },
    }),
};

export const tenant = {
  summary: () => request<TenantSummary>("/api/v1/tenant/summary"),

  ledger: (params: { period?: string; from?: string; to?: string; limit?: number } = {}) =>
    request<LedgerResponse>(`/api/v1/tenant/ledger${query(params)}`),

  trace: (entryId: string) => request<EntryTraceResponse>(`/api/v1/tenant/ledger/${entryId}/trace`),

  payments: () => request<{ payments: Payment[] }>("/api/v1/tenant/payments"),

  /**
   * Submit a payment.
   *
   * The idempotency key is generated once, by the caller, before the first
   * attempt — and reused on every retry of that same attempt. Generating one
   * here would defeat the mechanism entirely, since a retry would arrive with a
   * fresh key and be charged as a second payment.
   */
  pay: (input: { amountCents: number; paymentMethodId: string; expectedBalanceCents?: number }, idempotencyKey: string) =>
    request<{ payment: Payment; balanceCents: number; deduplicated: boolean }>("/api/v1/tenant/payments", {
      method: "POST",
      body: input,
      idempotencyKey,
    }),

  paymentMethods: () => request<{ paymentMethods: PaymentMethodSummary[] }>("/api/v1/tenant/payment-methods"),

  addPaymentMethod: (input: { kind: "ach" | "card"; providerToken: string; makeAutopayDefault?: boolean }) =>
    request<{ paymentMethods: PaymentMethodSummary[] }>("/api/v1/tenant/payment-methods", {
      method: "POST",
      body: input,
    }),

  verifyBank: (methodId: string, amountsCents: [number, number]) =>
    request<{ paymentMethods: PaymentMethodSummary[]; verified: boolean }>(
      `/api/v1/tenant/payment-methods/${methodId}/verify`,
      { method: "POST", body: { amountsCents } },
    ),

  removePaymentMethod: (methodId: string) =>
    request<{ paymentMethods: PaymentMethodSummary[] }>(`/api/v1/tenant/payment-methods/${methodId}`, {
      method: "DELETE",
    }),

  autopay: () => request<{ autopay: AutopayEnrollment | null }>("/api/v1/tenant/autopay"),

  /** shareCents (021): this person's share each month; null or absent for the whole balance. */
  enrollAutopay: (input: { paymentMethodId: string; dayOfMonth: number; capCents: number | null; shareCents?: number | null }) =>
    request<{ autopay: AutopayEnrollment }>("/api/v1/tenant/autopay", { method: "POST", body: input }),

  /** Stops only the caller's own autopay; a roommate's is left alone. */
  cancelAutopay: () =>
    request<{ autopay: AutopayEnrollment | null; leaseAutopays: AutopayEnrollment[] }>("/api/v1/tenant/autopay", { method: "DELETE" }),

  disputes: () => request<{ disputes: ChargeDispute[] }>("/api/v1/tenant/disputes"),

  openDispute: (input: { ledgerEntryId: string; reason: string }) =>
    request<{ dispute: ChargeDispute }>("/api/v1/tenant/disputes", { method: "POST", body: input }),

  withdrawDispute: (disputeId: string) =>
    request<{ disputes: ChargeDispute[] }>(`/api/v1/tenant/disputes/${disputeId}`, { method: "DELETE" }),

  workOrders: () =>
    request<{ workOrders: WorkOrder[]; priorityGuidance: Record<string, string> }>("/api/v1/tenant/work-orders"),

  workOrder: (id: string) => request<{ workOrder: WorkOrder }>(`/api/v1/tenant/work-orders/${id}`),

  submitWorkOrder: (input: {
    category: string;
    priority: string;
    title: string;
    description: string;
    entryPermission: boolean;
  }) => request<{ workOrder: WorkOrder }>("/api/v1/tenant/work-orders", { method: "POST", body: input }),

  addWorkOrderNote: (id: string, note: string) =>
    request<{ workOrder: WorkOrder }>(`/api/v1/tenant/work-orders/${id}/notes`, {
      method: "POST",
      body: { note },
    }),

  reopenWorkOrder: (id: string, note: string) =>
    request<{ workOrder: WorkOrder }>(`/api/v1/tenant/work-orders/${id}/reopen`, {
      method: "POST",
      body: { note },
    }),

  async uploadPhoto(workOrderId: string, file: File): Promise<{ workOrder: WorkOrder }> {
    const response = await fetch(`/api/v1/tenant/work-orders/${workOrderId}/photos`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        ...(csrfToken ? { "x-portal-csrf": csrfToken } : {}),
      },
      credentials: "same-origin",
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, error.code ?? "error", error.message ?? "Upload failed.");
    }
    return payload;
  },

  notifications: () =>
    request<{
      notifications: Array<{
        id: string;
        event_type: string;
        channel: string;
        subject: string;
        body: string;
        status: string;
        created_at: string;
        sent_at: string | null;
      }>;
    }>("/api/v1/tenant/notifications"),

  statementUrl: () => "/api/v1/tenant/statement.csv",
};

/* ------------------------------------------------------------------ *
 * Manager
 * ------------------------------------------------------------------ */

export const manager = {
  properties: () =>
    request<{
      properties: Array<{ id: string; name: string; city: string; state: string; unit_count: number; occupied: number; cover_photo_id: string | null }>;
      period: string;
    }>("/api/v1/manager/properties"),

  units: (params: { propertyId?: string; occupancy?: string } = {}) =>
    request<{ units: UnitRow[] }>(`/api/v1/manager/units${query(params)}`),

  tenants: (params: { propertyId?: string; status?: string; search?: string } = {}) =>
    request<{ tenants: TenantRow[] }>(`/api/v1/manager/tenants${query(params)}`),

  dashboard: (params: { period?: string; propertyId?: string } = {}) =>
    request<DashboardResponse>(`/api/v1/manager/dashboard${query(params)}`),

  rentRoll: (params: { period?: string; propertyId?: string; status?: string; search?: string; limit?: number } = {}) =>
    request<RentRollResponse>(`/api/v1/manager/rent-roll${query(params)}`),

  exceptions: (params: { period?: string; propertyId?: string } = {}) =>
    request<ExceptionsResponse>(`/api/v1/manager/exceptions${query(params)}`),

  tenancy: (tenancyId: string) =>
    request<{
      tenancy: Record<string, unknown>;
      balanceCents: number;
      entries: LedgerEntry[];
      activePlan: PaymentPlan | null;
      payments: Payment[];
      disputes: ChargeDispute[];
      workOrders: WorkOrder[];
      lateFeePolicy: string;
      leaseLateFee: LateFeeTerms | null;
      propertyLateFee: LateFeeTerms | null;
      propertyLateFeeText: string;
    }>(`/api/v1/manager/tenancies/${tenancyId}`),

  waiveFee: (input: { ledgerEntryId: string; reason: string; amountCents?: number }) =>
    request<{ original: LedgerEntry; reversal: LedgerEntry; balanceCents: number }>("/api/v1/manager/waive-fee", {
      method: "POST",
      body: input,
    }),

  recordPayment: (input: {
    tenancyId: string;
    amountCents: number;
    method: "check" | "cash" | "money_order";
    receivedOn: string;
    reference?: string;
    reason: string;
  }) =>
    request<{ payment: Payment; balanceCents: number }>("/api/v1/manager/record-payment", {
      method: "POST",
      body: input,
    }),

  adjust: (input: {
    tenancyId: string;
    category: string;
    amountCents: number;
    description: string;
    effectiveDate?: string;
    reason: string;
  }) =>
    request<{ entry: LedgerEntry; balanceCents: number }>("/api/v1/manager/adjustments", {
      method: "POST",
      body: input,
    }),

  reverse: (input: { ledgerEntryId: string; reason: string }) =>
    request<{ original: LedgerEntry; reversal: LedgerEntry; balanceCents: number }>("/api/v1/manager/reverse", {
      method: "POST",
      body: input,
    }),

  openPlan: (input: {
    tenancyId: string;
    totalCents: number;
    installments: number;
    firstDueDate: string;
    intervalDays?: number;
    reason: string;
    suspendLateFees?: boolean;
  }) => request<{ plan: PaymentPlan }>("/api/v1/manager/payment-plans", { method: "POST", body: input }),

  cancelPlan: (planId: string, reason: string) =>
    request<{ ok: boolean }>(`/api/v1/manager/payment-plans/${planId}`, { method: "DELETE", body: { reason } }),

  postCharges: (input: { period: string; propertyId?: string; dryRun: boolean }) =>
    request<{
      period: string;
      dryRun: boolean;
      posted: Array<{
        tenancyId: string;
        unitLabel: string;
        residentName: string;
        category: string;
        amountCents: number;
        description: string;
        alreadyPosted: boolean;
      }>;
      totalCents: number;
      newCount: number;
      skippedCount: number;
    }>("/api/v1/manager/post-charges", { method: "POST", body: input }),

  disputes: (propertyId?: string) =>
    request<{ disputes: ChargeDispute[] }>(`/api/v1/manager/disputes${query({ propertyId })}`),

  respondToDispute: (input: {
    disputeId: string;
    response: string;
    resolution: "upheld" | "adjusted" | "responded";
    adjustmentCents?: number;
  }) => request<{ dispute: ChargeDispute }>("/api/v1/manager/disputes/respond", { method: "POST", body: input }),

  workOrders: (params: { propertyId?: string; status?: string } = {}) =>
    request<{ workOrders: WorkOrder[]; targetHours: Record<string, number> }>(
      `/api/v1/manager/work-orders${query(params)}`,
    ),

  workOrder: (id: string) => request<{ workOrder: WorkOrder }>(`/api/v1/manager/work-orders/${id}`),

  updateWorkOrder: (
    id: string,
    input: {
      status?: string;
      note?: string;
      visibleToResident?: boolean;
      assignedToUserId?: string | null;
      creditCents?: number;
      creditReason?: string;
    },
  ) => request<{ workOrder: WorkOrder }>(`/api/v1/manager/work-orders/${id}`, { method: "POST", body: input }),

  /** File a request on a resident's behalf (phone call, walk-through). */
  createWorkOrder: (input: {
    tenancyId: string;
    category: string;
    priority: string;
    title: string;
    description: string;
    entryPermission: boolean;
  }) => request<{ workOrder: WorkOrder }>("/api/v1/manager/work-orders", { method: "POST", body: input }),

  lateFeePolicies: () =>
    request<{
      policies: Array<{
        propertyId: string;
        propertyName: string;
        enabled: boolean;
        graceDays: number;
        feeType: "flat" | "percent";
        flatCents: number;
        percent: number;
        dailyCents: number;
        maxCents: number;
        minBalanceCents: number;
        plainLanguage: string;
      }>;
    }>("/api/v1/manager/late-fee-policy"),

  saveLateFeePolicy: (input: Record<string, unknown>) =>
    request<{ plainLanguage: string }>("/api/v1/manager/late-fee-policy", { method: "POST", body: input }),

  staff: () =>
    request<{
      staff: Array<{
        user_id: string;
        display_name: string;
        email: string;
        role: Role;
        property_id: string;
        property_name: string;
        granted_at: string;
        revoked_at: string | null;
      }>;
      capabilitiesByRole: Record<Role, Capability[]>;
      roleLabels: Record<Role, string>;
      roleDescriptions: Record<Role, string>;
    }>("/api/v1/manager/staff"),

  audit: (subjectId?: string) =>
    request<{
      entries: Array<{
        id: string;
        action: string;
        actor_name: string | null;
        actor_role: string | null;
        subject_type: string | null;
        subject_id: string | null;
        detail: Record<string, unknown>;
        occurred_at: string;
      }>;
    }>(`/api/v1/manager/audit${query({ subjectId })}`),

  exportUrl: (params: { period: string; propertyId?: string; audience?: string; format?: string }) =>
    `/api/v1/manager/export${query(params)}`,
};

/* ------------------------------------------------------------------ *
 * Portfolio administration, lease people, documents, import
 * (after the 2026-09-28 client meeting)
 * ------------------------------------------------------------------ */

export interface PropertyPhoto {
  id: string;
  propertyId: string;
  unitId: string | null;
  unitLabel: string | null;
  caption: string | null;
  isCover: boolean;
  uploadedAt: string;
  uploadedByName: string | null;
}

export interface PropertyDetail {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  units: Array<{
    id: string;
    label: string;
    bedrooms: number | null;
    bathrooms: number | null;
    marketRentCents: number;
    tenancyId: string | null;
    residentName: string | null;
    coverPhotoId: string | null;
  }>;
}

export interface PropertyInput {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface UnitInput {
  propertyId?: string;
  label: string;
  bedrooms: number | null;
  bathrooms: number | null;
  marketRentCents: number;
}

export const portfolio = {
  property: (id: string) => request<{ property: PropertyDetail }>(`/api/v1/manager/properties/${id}`),
  createProperty: (input: PropertyInput) =>
    request<{ propertyId: string }>("/api/v1/manager/properties", { method: "POST", body: input }),
  updateProperty: (id: string, input: PropertyInput) =>
    request<{ propertyId: string }>(`/api/v1/manager/properties/${id}`, { method: "POST", body: input }),
  createUnit: (input: UnitInput) => request<{ unitId: string }>("/api/v1/manager/units", { method: "POST", body: input }),
  updateUnit: (id: string, input: UnitInput) =>
    request<{ unitId: string }>(`/api/v1/manager/units/${id}`, { method: "POST", body: input }),

  createLease: (input: {
    unitId: string;
    resident: ResidentContact;
    otherResidents: ResidentContact[];
    startsOn: string;
    endsOn: string | null;
    monthlyRentCents: number;
    rentDueDay: number;
    depositCents: number;
  }) => request<{ tenancyId: string; logins: IssuedLogin[] }>("/api/v1/manager/leases", { method: "POST", body: input }),
  updateLease: (id: string, input: { endsOn: string | null; monthlyRentCents: number; rentDueDay: number; depositCents: number }) =>
    request<{ ok: true }>(`/api/v1/manager/leases/${id}`, { method: "POST", body: input }),
  endLease: (id: string, endsOn: string) =>
    request<{ ok: true }>(`/api/v1/manager/leases/${id}/end`, { method: "POST", body: { endsOn } }),

  residents: (tenancyId: string) =>
    request<{ residents: LeaseResident[] }>(`/api/v1/manager/leases/${tenancyId}/residents`),
  addResident: (tenancyId: string, input: ResidentContact) =>
    request<{ login: IssuedLogin }>(`/api/v1/manager/leases/${tenancyId}/residents`, { method: "POST", body: input }),
  removeResident: (tenancyId: string, userId: string) =>
    request<{ ok: true }>(`/api/v1/manager/leases/${tenancyId}/residents/${userId}`, { method: "DELETE" }),
  updateResident: (userId: string, input: ResidentContact) =>
    request<{ ok: true }>(`/api/v1/manager/residents/${userId}`, { method: "POST", body: input }),
  resetPassword: (userId: string) =>
    request<{ temporaryPassword: string }>(`/api/v1/manager/residents/${userId}/reset-password`, { method: "POST" }),

  setLateFee: (tenancyId: string, input: Record<string, unknown>) =>
    request<{ plainLanguage: string }>(`/api/v1/manager/leases/${tenancyId}/late-fee`, { method: "POST", body: input }),
  clearLateFee: (tenancyId: string) =>
    request<{ plainLanguage: string }>(`/api/v1/manager/leases/${tenancyId}/late-fee`, { method: "DELETE" }),

  documents: (tenancyId: string) =>
    request<{ documents: LeaseDocument[] }>(`/api/v1/manager/leases/${tenancyId}/documents`),
  async uploadDocument(
    tenancyId: string,
    file: File,
    options: { title: string; requiresSignature: boolean },
  ): Promise<{ documentId: string; documents: LeaseDocument[] }> {
    const params = query({
      title: options.title,
      fileName: file.name,
      requiresSignature: options.requiresSignature ? "1" : "0",
    });
    const response = await fetch(`/api/v1/manager/leases/${tenancyId}/documents${params}`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        ...(csrfToken ? { "x-portal-csrf": csrfToken } : {}),
      },
      credentials: "same-origin",
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, error.code ?? "error", error.message ?? "Upload failed.");
    }
    return payload;
  },
  withdrawDocument: (documentId: string) =>
    request<{ ok: true }>(`/api/v1/manager/documents/${documentId}/withdraw`, { method: "POST" }),
  documentUrl: (documentId: string, download = false) =>
    `/api/v1/documents/${documentId}/file${download ? "?download=1" : ""}`,

  myDocuments: () => request<{ documents: LeaseDocument[] }>("/api/v1/tenant/documents"),
  sign: (documentId: string, typedName: string, sha256: string) =>
    request<{ documents: LeaseDocument[] }>(`/api/v1/tenant/documents/${documentId}/sign`, {
      method: "POST",
      body: { typedName, sha256, agree: true },
    }),

  screening: () => request<{ screening: ScreeningSettings }>("/api/v1/manager/settings/screening"),
  saveScreening: (input: { provider: string; url: string }) =>
    request<{ screening: ScreeningSettings }>("/api/v1/manager/settings/screening", { method: "POST", body: input }),

  recurring: (tenancyId: string) =>
    request<{ charges: RecurringCharge[] }>(`/api/v1/manager/leases/${tenancyId}/recurring`),
  addRecurring: (
    tenancyId: string,
    input: { category: string; amountCents: number; description: string; dayOfMonth: number; startsOn: string; endsOn: string | null },
  ) => request<{ charges: RecurringCharge[] }>(`/api/v1/manager/leases/${tenancyId}/recurring`, { method: "POST", body: input }),
  stopRecurring: (chargeId: string) =>
    request<{ charges: RecurringCharge[] }>(`/api/v1/manager/recurring/${chargeId}/stop`, { method: "POST" }),

  photos: (propertyId: string, unitId?: string) =>
    request<{ photos: PropertyPhoto[] }>(`/api/v1/manager/properties/${propertyId}/photos${query({ unitId })}`),
  async uploadPhoto(propertyId: string, file: File, options: { unitId?: string; caption?: string } = {}): Promise<{ photos: PropertyPhoto[] }> {
    const response = await fetch(`/api/v1/manager/properties/${propertyId}/photos${query({ unitId: options.unitId, caption: options.caption })}`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        ...(csrfToken ? { "x-portal-csrf": csrfToken } : {}),
      },
      credentials: "same-origin",
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, error.code ?? "error", error.message ?? "Upload failed.");
    }
    return payload;
  },
  makeCover: (photoId: string) =>
    request<{ photos: PropertyPhoto[] }>(`/api/v1/manager/photos/${photoId}/cover`, { method: "POST" }),
  captionPhoto: (photoId: string, caption: string) =>
    request<{ photos: PropertyPhoto[] }>(`/api/v1/manager/photos/${photoId}/caption`, { method: "POST", body: { caption } }),
  removePhoto: (photoId: string) =>
    request<{ photos: PropertyPhoto[] }>(`/api/v1/manager/photos/${photoId}/remove`, { method: "POST" }),
  photoUrl: (photoId: string) => `/api/v1/property-photos/${photoId}`,

  templateUrl: (kind: ImportKind) => `/api/v1/manager/import/template/${kind}`,
  runImport: (input: { kind: ImportKind; csv: string; dryRun: boolean; source: string }) =>
    request<{ report: ImportReport }>("/api/v1/manager/import", { method: "POST", body: input }),
};

export const health = () =>
  request<{ status: string; database: string; paymentsProvider: string; paymentsSimulated: boolean }>(
    "/api/v1/health",
  );
