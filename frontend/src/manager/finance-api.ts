// The finance API (src/routes/finance.ts). Shapes mirror src/types/finance.ts.
import { apiFetch } from "../api/session";
import { ManagerApiError } from "./api";

export type FinancePeriod = "this-month" | "30d" | "90d" | "ytd" | "12m";
export const PERIODS: Array<[FinancePeriod, string]> = [
  ["this-month", "This month"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["ytd", "Year to date"],
  ["12m", "Last 12 months"],
];

export interface ResidentContact {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90plus: number;
  total: number;
}

export interface CollectionRow extends AgingBuckets {
  leaseId: number;
  unitLabel: string;
  propertyId: number;
  propertyName: string;
  tenants: ResidentContact[];
  monthlyRent: number;
  balance: number;
  credit: number;
  oldestUnpaidDue: string | null;
  daysLate: number;
  monthsBehind: number;
  lastPayment: { amount: number; paidAt: string } | null;
  lateFeesBilled: number;
  lastContactAt: string | null;
  ended: boolean;
}

export interface RecentPaymentRow {
  id: number;
  leaseId: number;
  payer: string;
  unitLabel: string;
  propertyName: string;
  amount: number;
  paidAt: string;
  method: string | null;
  confirmation: string;
  status: "paid" | "partial" | "prepaid" | "refund";
  /** Not applied to a charge yet: paid ahead, held as credit. */
  ahead: number;
  forCharge: { kind: string; dueDate: string } | null;
}

export interface MonthRow {
  month: string;
  label: string;
  billed: number;
  collected: number;
  expenses: number;
  net: number;
}

export const EXPENSE_CATEGORIES = [
  ["repairs", "Repairs & maintenance"],
  ["utilities", "Utilities"],
  ["insurance", "Insurance"],
  ["taxes", "Property taxes"],
  ["mortgage", "Mortgage interest"],
  ["management", "Management & payroll"],
  ["supplies", "Supplies"],
  ["legal", "Legal & professional"],
  ["marketing", "Advertising"],
  ["other", "Other"],
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number][0];
export const expenseLabel = (c: string) => EXPENSE_CATEGORIES.find(([k]) => k === c)?.[1] ?? c;

export interface ExpenseRow {
  id: number;
  propertyId: number | null;
  propertyName: string | null;
  unitId: number | null;
  unitNum: string | null;
  category: ExpenseCategory;
  amount: number;
  spentOn: string;
  vendor: string | null;
  description: string | null;
  createdBy: string | null;
}

export interface ProfitAndLoss {
  income: Array<{ category: string; label: string; billed: number; collected: number }>;
  prepaid: number;
  refunds: number;
  totalBilled: number;
  totalCollected: number;
  expenses: Array<{ category: ExpenseCategory; label: string; amount: number }>;
  totalExpenses: number;
  netOperatingIncome: number;
  margin: number;
  byProperty: Array<{ propertyId: number | null; name: string; billed: number; collected: number; expenses: number; net: number }>;
}

export interface FinanceOverview {
  asOf: string;
  lateAfterDays: number;
  period: { key: FinancePeriod; label: string; from: string; to: string };
  summary: {
    chargesDue: number;
    paid: number;
    open: number;
    late: number;
    collectedRate: number;
    cashCollected: number;
    refunds: number;
    expenses: number;
    net: number;
  };
  aging: AgingBuckets & { accounts: number };
  collections: CollectionRow[];
  recentPayments: RecentPaymentRow[];
  monthly: MonthRow[];
  pnl: ProfitAndLoss;
  expenses: ExpenseRow[];
}

export interface MonthTrend {
  month: string;
  label: string;
  billed: number;
  collected: number;
  collectionRate: number;
  expenses: number;
  noi: number;
  occupancy: number;
}

export interface PropertyPerformance {
  id: number;
  name: string;
  units: number;
  occupied: number;
  occupancy: number;
  rentRoll: number;
  avgRent: number;
  billed12m: number;
  collected12m: number;
  collectionRate: number;
  expenses12m: number;
  noi12m: number;
  outstanding: number;
  openMaintenance: number;
  expiring90: number;
}

export interface Analytics {
  asOf: string;
  lateAfterDays: number;
  kpis: {
    units: number;
    occupied: number;
    vacant: number;
    occupancy: number;
    rentRoll: number;
    avgRent: number;
    billed12m: number;
    collected12m: number;
    collectionRate12m: number;
    expenses12m: number;
    noi12m: number;
    outstanding: number;
    delinquencyRate: number;
    onTimeRate: number;
    avgDaysToPay: number;
    openMaintenance: number;
    avgResolutionDays: number | null;
    expiring90: number;
  };
  trend: MonthTrend[];
  properties: PropertyPerformance[];
  maintenance: { submitted: number; inProgress: number; resolved12m: number; avgResolutionDays: number | null; oldestOpenDays: number | null };
}

export interface ExpiringLeaseRow {
  leaseId: number;
  unitLabel: string;
  propertyId: number;
  propertyName: string;
  tenants: ResidentContact[];
  endDate: string;
  daysLeft: number;
  monthlyRent: number;
  balance: number;
  lastNotice: { sentAt: string; recipients: number } | null;
}

/** A Cash App / Zelle payment a tenant reported (006). Shapes mirror src/types/settings.ts. */
export type ManualPayMethod = "cashapp" | "zelle";
export const MANUAL_PAY_LABELS: Record<ManualPayMethod, string> = { cashapp: "Cash App", zelle: "Zelle" };

export interface ReportedPaymentRow {
  id: number;
  leaseId: number;
  unitLabel: string;
  propertyName: string;
  tenantName: string;
  method: ManualPayMethod;
  amount: number;
  reportedAt: string;
  confirmation: string;
  /** The lease's balance now (the report does not count until it is confirmed). */
  balance: number;
  status: "pending" | "confirmed" | "rejected";
  reason: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

/** Where tenants send Cash App / Zelle payments. */
export interface OfficeSettings {
  cashappHandle: string | null;
  zelleHandle: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`/api/manager${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ManagerApiError((body as { error?: string }).error ?? "UNKNOWN", res.status);
  return body as T;
}
const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const financeApi = {
  overview: (period: FinancePeriod) => call<FinanceOverview>(`/finance?period=${period}`),
  analytics: () => call<Analytics>("/analytics"),
  expiring: (days = 90) => call<{ days: number; leases: ExpiringLeaseRow[] }>(`/leases/expiring?days=${days}`).then((r) => r.leases),
  renewalDraft: (leaseId: number) => call<{ body: string }>(`/leases/${leaseId}/renewal-notice`).then((r) => r.body),
  sendRenewal: (leaseId: number, body: string) => send<{ recipients: number }>("POST", `/leases/${leaseId}/renewal-notice`, { body }),
  addExpense: (input: {
    category: ExpenseCategory;
    amount: number;
    spentOn: string;
    propertyId: number | null;
    unitId: number | null;
    vendor: string | null;
    description: string | null;
  }) => send<{ id: number }>("POST", "/expenses", input),
  voidExpense: (id: number) => send<{ ok: true }>("DELETE", `/expenses/${id}`),
  reported: (status: "pending" | "all" = "pending") =>
    call<{ payments: ReportedPaymentRow[] }>(`/payments/reported?status=${status}`).then((r) => r.payments),
  confirmReport: (payId: number) => send<ReportedPaymentRow>("POST", `/payments/${payId}/confirm`),
  rejectReport: (payId: number, reason: string) => send<ReportedPaymentRow>("POST", `/payments/${payId}/reject`, { reason }),
  settings: () => call<OfficeSettings>("/settings"),
  saveSettings: (input: { cashappHandle: string | null; zelleHandle: string | null }) => send<OfficeSettings>("PUT", "/settings", input),
};

/** Download rows as a CSV file the office can open in Excel or Google Sheets. */
export function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const cell = (v: string | number) => {
    const s = String(v);
    // Quote anything with a comma, quote or newline; neutralise spreadsheet formulas.
    const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
