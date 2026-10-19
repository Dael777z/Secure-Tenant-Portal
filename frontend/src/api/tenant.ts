// The tenant API (src/routes/tenant.ts) and Dael's Plaid routes (src/routes/plaid.ts).
import type { LedgerEntry, MaintenanceRequest, Notice, Tenant } from "../types";
import { apiFetch } from "./session";

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
  /** Development only: paying without a linked bank records a test transfer. */
  testPayments: boolean;
}

/** Extra facts some errors carry; PLAID_ERROR has plaid's code, request id and a message. */
export interface ErrorDetails {
  operation?: string;
  plaidCode?: string;
  plaidType?: string;
  requestId?: string | null;
  message?: string | null;
}

/** A message between the tenant and the office (src/routes/messages.ts). Times are ISO strings. */
export interface OfficeMessage {
  id: number;
  from: "tenant" | "office";
  /** The manager who wrote it; null for the tenant's own messages. */
  senderName: string | null;
  body: string;
  sentAt: string;
  /** The receipt: when the other side opened the conversation. */
  readAt: string | null;
}

export const MESSAGE_MAX_LENGTH = 2000;

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly details?: ErrorDetails) {
    super(code);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`/api${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, details } = body as { error?: string; details?: ErrorDetails };
    throw new ApiError(error ?? "UNKNOWN", res.status, details);
  }
  return body as T;
}

export const tenantApi = {
  summary: () => call<TenantSummary>("/tenant/summary"),
  /** `checkoutKey`: one per checkout, so a double click or a retry is recorded once. */
  pay: (amount: number, bankAccountId: string | null, checkoutKey: string) =>
    call<{ confirmation: string }>("/tenant/payments", {
      method: "POST",
      body: JSON.stringify({ amount, bankAccountId, idempotencyKey: checkoutKey }),
    }),
  newMaintenanceRequest: (title: string, description: string) =>
    call<MaintenanceRequest>("/tenant/maintenance", { method: "POST", body: JSON.stringify({ title, description }) }),
  /** The conversation with the office; `unread` counts the office's messages not opened yet. */
  messages: () => call<{ messages: OfficeMessage[]; unread: number }>("/tenant/messages"),
  sendMessage: (body: string) => call<OfficeMessage>("/tenant/messages", { method: "POST", body: JSON.stringify({ body }) }),
  /** The receipt: the office sees its messages were read. */
  markMessagesRead: () => call<{ marked: number }>("/tenant/messages/read", { method: "POST" }),
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
    if (error.code === "PLAID_ERROR") {
      // plaid's own message when it gave one, and its code so the server log can be matched up
      const message = error.details?.message ?? "Plaid could not complete that. Please try again.";
      return error.details?.plaidCode ? `${message} (Plaid: ${error.details.plaidCode})` : message;
    }
    if (error.code === "VALIDATION_ERROR") return "Check what you entered and try again.";
    if (error.code === "RATE_LIMITED") return "Too many messages at once. Wait a few minutes and try again.";
  }
  return "Something went wrong. Please try again.";
}
