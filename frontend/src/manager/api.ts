// The manager API (src/routes/manager.ts). Shapes mirror src/types/manager.ts.
import type { LedgerEntry } from "../types";
import { apiFetch } from "../api/session";

export interface StaffProfile {
  name: string;
  email: string;
  role: string;
}

export interface PropertySummary {
  id: number;
  name: string;
  address: string;
  units: number;
  occupied: number;
  monthlyRent: number;
  outstanding: number;
}

export type UnitStatus = "vacant" | "current" | "owing";

export interface UnitRow {
  id: number;
  propertyId: number;
  propertyName: string;
  unitNum: string;
  leaseId: number | null;
  tenants: Array<{ id: number; name: string }>;
  monthlyRent: number | null;
  balance: number;
  startDate: string | null;
  endDate: string | null;
  status: UnitStatus;
  openRequests: number;
}

export interface TenantRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  signedUp: boolean;
  leaseId: number | null;
  unitLabel: string | null;
  balance: number;
}

export interface LeaseDetail {
  id: number;
  unitId: number;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  address: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: number;
  tenants: Array<{ id: number; name: string; email: string; phone: string | null; signedUp: boolean }>;
  balance: number;
  ledger: LedgerEntry[];
}

export type RequestStatus = "submitted" | "in_progress" | "resolved";

export interface MaintenanceRow {
  id: number;
  title: string;
  description: string;
  status: RequestStatus;
  submittedDate: string;
  unitId: number;
  unitNum: string;
  propertyName: string;
  tenantName: string | null;
}

export interface UpdateRow {
  kind: "overdue" | "maintenance_new" | "not_signed_up";
  title: string;
  detail: string;
  leaseId: number | null;
  unitLabel: string;
  amount: number | null;
  severity: number;
}

export interface ActivityRow {
  kind: "payment" | "maintenance";
  title: string;
  detail: string;
  when: string;
  at: string;
}

export interface DashboardData {
  properties: number;
  units: number;
  occupied: number;
  vacant: number;
  expectedThisMonth: number;
  collectedThisMonth: number;
  outstanding: number;
  overdueAccounts: number;
  openMaintenance: number;
  recentActivity: ActivityRow[];
  updates: UpdateRow[];
}

export interface NewPerson {
  name: string;
  email: string;
  phone: string;
}

export const PAYMENT_METHODS = ["Check", "Cash", "Money order", "Bank transfer"] as const;

export class ManagerApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`/api/manager${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ManagerApiError((body as { error?: string }).error ?? "UNKNOWN", res.status);
  return body as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const managerApi = {
  me: () => call<StaffProfile>("/me"),
  dashboard: () => call<DashboardData>("/dashboard"),
  properties: () => call<{ properties: PropertySummary[] }>("/properties").then((r) => r.properties),
  units: (propertyId?: number) =>
    call<{ units: UnitRow[] }>(propertyId ? `/units?propertyId=${propertyId}` : "/units").then((r) => r.units),
  tenants: () => call<{ tenants: TenantRow[] }>("/tenants").then((r) => r.tenants),
  lease: (id: number) => call<LeaseDetail>(`/leases/${id}`),
  updates: () => call<{ updates: UpdateRow[] }>("/updates").then((r) => r.updates),
  maintenance: () => call<{ requests: MaintenanceRow[]; units: Array<{ id: number; label: string }> }>("/maintenance"),

  saveProperty: (id: number | null, input: { name: string; address: string }) =>
    id ? send<{ id: number }>("PUT", `/properties/${id}`, input) : send<{ id: number }>("POST", "/properties", input),
  saveUnit: (id: number | null, input: { propertyId: number; unitNum: string }) =>
    id ? send<{ id: number }>("PUT", `/units/${id}`, input) : send<{ id: number }>("POST", "/units", input),
  inviteTenant: (input: NewPerson) => send<{ id: number }>("POST", "/tenants", input),
  updateTenant: (id: number, input: { name: string; phone: string }) => send<{ ok: true }>("PUT", `/tenants/${id}`, input),
  createLease: (input: {
    unitId: number;
    startDate: string;
    endDate: string | null;
    monthlyRent: number;
    tenantIds: number[];
    newTenants: NewPerson[];
  }) => send<{ id: number }>("POST", "/leases", input),
  updateLease: (id: number, input: { monthlyRent?: number; endDate?: string | null }) =>
    send<{ ok: true }>("PUT", `/leases/${id}`, input),
  addTenantToLease: (id: number, input: { tenantId: number } | { newTenant: NewPerson }) =>
    send<{ ok: true }>("POST", `/leases/${id}/tenants`, input),
  removeTenantFromLease: (id: number, tenantId: number) => send<{ ok: true }>("DELETE", `/leases/${id}/tenants/${tenantId}`),
  recordPayment: (leaseId: number, input: { amount: number; method: string; tenantId: number | null }) =>
    send<{ confirmation: string }>("POST", `/leases/${leaseId}/payments`, input),
  createMaintenance: (input: { unitId: number; title: string; description: string }) =>
    send<{ id: number }>("POST", "/maintenance", input),
  setMaintenanceStatus: (id: number, status: RequestStatus) => send<{ ok: true }>("PUT", `/maintenance/${id}`, { status }),
};

/** Plain words for a failed call. */
export function managerMessage(error: unknown): string {
  if (error instanceof ManagerApiError) {
    if (error.status === 401) return "Your session ended. Sign in again.";
    if (error.status === 403) return "Your role cannot do that.";
    if (error.code === "UNIT_OCCUPIED") return "That unit already has an active lease. End it first.";
    if (error.code === "EMAIL_IN_USE") return "Someone already uses that email address.";
    if (error.code === "NOT_FOUND") return "That record no longer exists. Refresh and try again.";
    if (error.code === "VALIDATION_ERROR") return "Some details are missing or not valid. Check the form and try again.";
    if (error.code === "DATABASE_REQUIRED") return "The database is not connected.";
  }
  return "We could not reach the server. Check your connection and try again.";
}
