// The RentRedi-style management API (src/routes/operations.ts, migration 008):
// Rent & Charges, the unit page, lease PDFs, late fee rules, rent reminders,
// the team and office notifications. Shapes mirror src/types/operations.ts.
import { apiFetch } from "../api/session";
import { ManagerApiError, type ReceiptUpload } from "./api";

export type FeeType = "flat" | "percent";

export interface ScopeLabel {
  label: string;
  propertyId: number | null;
  unitId: number | null;
}

export interface LateFeeRule extends ScopeLabel {
  id: number;
  graceDays: number;
  firstAmount: number;
  firstType: FeeType;
  dailyAmount: number;
  dailyType: FeeType;
  maxAmount: number | null;
  maxType: FeeType;
  createdAt: string;
  createdBy: string | null;
}

export interface ReminderRule extends ScopeLabel {
  id: number;
  daysBefore: number;
  repeatAfterDue: boolean;
  createdAt: string;
  createdBy: string | null;
}

export interface UnitRule {
  unitId: number;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  ruleId: number | null;
  source: "unit" | "property" | "all" | null;
}

export interface ReminderSent {
  chargeId: number;
  leaseId: number;
  unitLabel: string;
  tenants: string[];
  sentOn: string;
  kind: "upcoming" | "due" | "overdue";
  amount: number;
  dueDate: string;
}

export interface ChargeRow {
  id: number;
  leaseId: number;
  unitId: number;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  tenants: Array<{ id: number; name: string }>;
  kind: string;
  kindLabel: string;
  description: string;
  dueDate: string;
  amount: number;
  paid: number;
  unpaid: number;
  status: "paid" | "due" | "late";
  source: "manual" | "online" | "both" | null;
  paidOn: string | null;
}

export interface ChargesView {
  from: string;
  to: string;
  summary: { charged: number; paid: number; due: number; late: number };
  allTimeLate: number;
  rows: ChargeRow[];
}

export interface UnitLease {
  id: number;
  startDate: string;
  endDate: string | null;
  monthlyRent: number;
  tenants: Array<{ id: number; name: string }>;
  balance: number;
  state: "current" | "upcoming" | "ended";
  document: { filename: string; uploadedAt: string } | null;
}

export interface UnitDetail {
  id: number;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  address: string;
  leaseId: number | null;
  leases: UnitLease[];
  performance: {
    billed: number;
    collected: number;
    collectionRate: number | null;
    onTimeRate: number | null;
    monthsLeased: number;
    openRequests: number;
  };
  maintenance: Array<{ id: number; title: string; status: string; priority: string; submittedDate: string }>;
}

export interface DocumentRow {
  kind: "lease" | "receipt";
  leaseId: number;
  unitLabel: string;
  tenants: string[];
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string | null;
  paymentId: number | null;
}

export interface StaffMember {
  id: number;
  name: string;
  email: string;
  role: string;
}

export interface OfficeNotifications {
  notifyEmail: string | null;
  newMaintenance: boolean;
  tenantMessage: boolean;
  reportedPayment: boolean;
  lateRent: boolean;
}

export interface NewLateFeeRule {
  propertyId: number | null;
  unitId: number | null;
  graceDays: number;
  firstAmount: number;
  firstType: FeeType;
  dailyAmount: number;
  dailyType: FeeType;
  maxAmount: number | null;
  maxType: FeeType;
}

export interface NewReminderRule {
  propertyId: number | null;
  unitId: number | null;
  daysBefore: number;
  repeatAfterDue: boolean;
}

/** Every kind of charge the office can add (rent is billed automatically). */
export const CHARGE_KINDS = [
  { kind: "late_fee", label: "Late fee" },
  { kind: "deposit", label: "Security deposit" },
  { kind: "utility", label: "Utility bill" },
  { kind: "parking", label: "Parking" },
  { kind: "hoa", label: "HOA fee" },
  { kind: "repair", label: "Repair billed to resident" },
  { kind: "non_compliance", label: "Non-compliance fee" },
  { kind: "proration", label: "Prorated rent" },
  { kind: "misc_income", label: "Miscellaneous income" },
  { kind: "other", label: "Other" },
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number]["kind"];
export const MAX_REPEATS = 24;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`/api/manager${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ManagerApiError((body as { error?: string }).error ?? "UNKNOWN", res.status);
  return body as T;
}
const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const opsApi = {
  charges: (from: string | null, to: string | null) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const s = q.toString();
    return call<ChargesView>(`/charges${s ? `?${s}` : ""}`);
  },
  addCharges: (leaseId: number, input: { kind: ChargeKind; amount: number; dueDate: string; description: string | null; occurrences: number }) =>
    send<{ id: number; ids: number[] }>("POST", `/leases/${leaseId}/charges`, input),
  unit: (unitId: number) => call<UnitDetail>(`/units/${unitId}`),
  documents: () => call<{ documents: DocumentRow[] }>("/documents").then((r) => r.documents),
  uploadLeaseDocument: (leaseId: number, file: ReceiptUpload) => send<{ ok: true }>("PUT", `/leases/${leaseId}/document`, file),
  lateFeeRules: () => call<{ rules: LateFeeRule[]; units: UnitRule[] }>("/late-fee-rules"),
  saveLateFeeRule: (input: NewLateFeeRule) => send<{ id: number }>("POST", "/late-fee-rules", input),
  retireLateFeeRule: (id: number) => send<{ ok: true }>("DELETE", `/late-fee-rules/${id}`),
  reminderRules: () => call<{ rules: ReminderRule[]; units: UnitRule[]; sent: ReminderSent[] }>("/reminder-rules"),
  saveReminderRule: (input: NewReminderRule) => send<{ id: number }>("POST", "/reminder-rules", input),
  retireReminderRule: (id: number) => send<{ ok: true }>("DELETE", `/reminder-rules/${id}`),
  staff: () => call<{ staff: StaffMember[] }>("/staff").then((r) => r.staff),
  notifications: () => call<OfficeNotifications>("/settings/notifications"),
  saveNotifications: (input: OfficeNotifications) => send<OfficeNotifications>("PUT", "/settings/notifications", input),
};

/** Where the browser opens a lease's signed PDF. */
export const leaseDocumentUrl = (leaseId: number) => `/api/manager/leases/${leaseId}/document`;

/** A fee in dollars: flat, or a percent of the rent charge (same rule as the server). */
export function feeFor(amount: number, type: FeeType, rent: number): number {
  return type === "percent" ? Math.round(rent * amount) / 100 : amount;
}

/** The fee schedule a rule gives a rent charge while it stays unpaid (mirrors lateFeeSchedule on the server). */
export function lateFeeSchedule(rule: Pick<NewLateFeeRule, "graceDays" | "firstAmount" | "firstType" | "dailyAmount" | "dailyType" | "maxAmount" | "maxType">, rent: number, days: number) {
  const c = (d: number) => Math.round(d * 100);
  const cap = rule.maxAmount === null ? null : c(feeFor(rule.maxAmount, rule.maxType, rent));
  let total = 0;
  const out: Array<{ daysLate: number; fee: number; total: number }> = [];
  for (let k = 0; k <= days; k++) {
    let fee = 0;
    if (k === rule.graceDays) fee = c(feeFor(rule.firstAmount, rule.firstType, rent));
    else if (k > rule.graceDays) fee = c(feeFor(rule.dailyAmount, rule.dailyType, rent));
    if (cap !== null) fee = Math.max(0, Math.min(fee, cap - total));
    total += fee;
    out.push({ daysLate: k, fee: fee / 100, total: total / 100 });
  }
  return out;
}

/** "YYYY-MM-DD" n months after date, clamped to the month's last day. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** First and last day of the month holding `iso`. */
export function monthRange(iso: string): { from: string; to: string } {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const from = `${iso.slice(0, 7)}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to };
}

export function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
