// The tenant API (src/routes/tenant.ts) and Dael's Plaid routes (src/routes/plaid.ts).
import type { LedgerEntry, MaintenanceRequest, Notice, Tenant } from "../types";

export interface LinkedBankAccount {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
}

export interface TenantSummary {
  tenant: Tenant;
  currentBalance: number;
  rentDueDate: string;
  lateFeeGraceDate: string;
  ledger: LedgerEntry[];
  maintenanceRequests: MaintenanceRequest[];
  notices: Notice[];
  bankAccounts: LinkedBankAccount[];
  plaidEnabled: boolean;
}

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? "UNKNOWN", res.status);
  return body as T;
}

export const tenantApi = {
  summary: () => call<TenantSummary>("/tenant/summary"),
  pay: (amount: number, bankAccountId: string | null) =>
    call<{ confirmation: string }>("/tenant/payments", { method: "POST", body: JSON.stringify({ amount, bankAccountId }) }),
  newMaintenanceRequest: (title: string, description: string) =>
    call<MaintenanceRequest>("/tenant/maintenance", { method: "POST", body: JSON.stringify({ title, description }) }),
  // Dael's two Plaid calls, same paths as his prototype.
  createLinkToken: () => call<{ link_token: string }>("/create_link_token", { method: "POST" }),
  exchangeAndGetAuth: (publicToken: string) =>
    call<{ bankAccounts: LinkedBankAccount[] }>("/exchange_and_get_auth", { method: "POST", body: JSON.stringify({ public_token: publicToken }) }),
};

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session ended. Sign in again.";
    if (error.code === "NO_ACTIVE_LEASE") return "There is no active lease on your account yet. Contact the office.";
    if (error.code === "PLAID_NOT_CONFIGURED") return "Bank linking is not set up on this server yet.";
    if (error.code === "PLAID_ERROR") return "Plaid could not complete that. Please try again.";
    if (error.code === "VALIDATION_ERROR") return "Check what you entered and try again.";
  }
  return "Something went wrong. Please try again.";
}
