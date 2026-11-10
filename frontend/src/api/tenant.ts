import { formatCurrency } from "../components/formatCurrency";
// The tenant API (src/routes/tenant.ts) and Dael's Plaid routes (src/routes/plaid.ts).
import type { LedgerEntry, MaintenanceRequest, ManualPayMethod, Notice, Tenant } from "../types";
import { apiFetch } from "./session";

export interface LinkedBankAccount {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
}

/** Email choices (Settings). Email only; no text messages. */
export interface NotificationPrefs {
  rentDue: boolean;
  paymentReceipts: boolean;
  maintenance: boolean;
  messages: boolean;
}

/** A Cash App / Zelle payment the tenant reported, and what the office decided. */
export interface ReportedPayment {
  id: number;
  method: ManualPayMethod;
  amount: number;
  reportedOn: string;
  status: "pending" | "confirmed" | "rejected";
  reason: string | null;
}

/** What Pay rent accepts right now: at least the balance, at most prepayMonths of rent beyond it. */
export interface PayLimits {
  minimum: number;
  maximum: number;
  monthlyRent: number;
  /** Credit already held (paid ahead), 0 if none. */
  credit: number;
  prepayMonths: number;
  /** False once the tenant is already paid the full limit ahead. */
  canPay: boolean;
}

export interface TenantSummary {
  tenant: Tenant;
  /** The tenant's own contact details; the email is their sign-in. */
  contact: { email: string; phone: string | null };
  /** Where to send Cash App / Zelle; null when the office has not set one up. */
  payOptions: { cashapp: string | null; zelle: string | null };
  reportedPayments: ReportedPayment[];
  notificationPrefs: NotificationPrefs;
  /** Negative when the tenant has paid ahead (credit). */
  currentBalance: number;
  payLimits: PayLimits | null;
  rentDueDate: string;
  lateFeeGraceDate: string;
  ledger: LedgerEntry[];
  maintenanceRequests: MaintenanceRequest[];
  notices: Notice[];
  bankAccounts: LinkedBankAccount[];
  plaidEnabled: boolean;
  /** Development only: paying without a linked bank records a test transfer. */
  testPayments: boolean;
  /** Cards, Apple Pay and Google Pay through Stripe; false when the server has no Stripe keys. */
  cardsEnabled: boolean;
  /** For Stripe.js; null when Stripe is off. */
  stripePublishableKey: string | null;
  /** The fee on card payments; null for none. */
  cardFee: { basisPoints: number; fixedCents: number } | null;
  /** The signed lease on file (opens at /api/tenant/lease-document); null if none. */
  leaseDocument?: { filename: string; uploadedOn: string } | null;
}

/** A card payment's place on the ledger: only "completed" is on the balance. */
export type CardPaymentStatus = "pending" | "completed" | "failed";

/** Extra facts some errors carry; PLAID_ERROR has plaid's code, request id and a message. */
export interface ErrorDetails {
  operation?: string;
  plaidCode?: string;
  stripeCode?: string | null;
  plaidType?: string;
  requestId?: string | null;
  balance?: number;
  minimum?: number;
  maximum?: number;
  prepayMonths?: number;
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

/** A document in the tenant's Documents page: their signed lease, or one the office shared (009). */
export interface TenantDocument {
  id: number;
  kind: "document" | "lease_pdf";
  title: string;
  filename: string;
  uploadedAt: string;
  href: string;
}
export interface DocumentGroup {
  category: "lease" | "inspection" | "insurance" | "notice" | "receipt" | "other";
  label: string;
  documents: TenantDocument[];
}

/** A notice the office wrote to the tenant (009). */
export interface OfficeNotice {
  id: number;
  template: string;
  subject: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/** A photo on one of the tenant's maintenance requests (009). */
export interface RequestPhoto {
  id: number;
  filename: string;
  href: string;
}

export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** "mr_12" (how the summary names requests) → 12. */
export const requestNumber = (id: string) => Number(id.replace(/^mr_/, ""));

/** A photo as { filename, data } (base64) for the upload routes. Throws a message to show when it can't be sent. */
export async function readPhoto(file: File): Promise<{ filename: string; data: string }> {
  if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
    throw new Error("iPhone HEIC photos can't be uploaded. On the iPhone, set Camera → Formats → Most Compatible, or upload a screenshot of the photo.");
  }
  if (!PHOTO_ACCEPT.split(",").includes(file.type)) throw new Error("Upload a JPEG, PNG or WebP photo.");
  if (file.size > PHOTO_MAX_BYTES) throw new Error("That photo is over 5 MB. Take a smaller photo or crop it.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: file.name, data: btoa(binary) };
}

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
  /** Cash App / Zelle: the tenant sent the full balance in their own app. Pending until the office confirms it. */
  reportPayment: (method: ManualPayMethod, amount: number, checkoutKey: string) =>
    call<{ confirmation: string }>("/tenant/payments/report", {
      method: "POST",
      body: JSON.stringify({ method, amount, idempotencyKey: checkoutKey }),
    }),
  /** Pay `amount` toward rent by card, Apple Pay or Google Pay: Stripe.js made the token, the server adds the fee and charges it. */
  payCard: (amount: number, checkoutKey: string, confirmationTokenId: string) =>
    call<{ paymentIntentId: string; clientSecret: string; status: CardPaymentStatus; requiresAction: boolean; fee: number; total: number }>("/tenant/payments/card", {
      method: "POST",
      body: JSON.stringify({ amount, idempotencyKey: checkoutKey, confirmationTokenId }),
    }),
  /** Ask the server to read a card payment from Stripe now (instead of waiting for Stripe's webhook). */
  refreshCardPayment: (paymentIntentId: string) =>
    call<{ status: CardPaymentStatus; confirmation: string }>(`/tenant/payments/stripe/${encodeURIComponent(paymentIntentId)}/refresh`, { method: "POST" }),
  updateProfile: (name: string, phone: string) =>
    call<{ ok: true }>("/tenant/profile", { method: "PUT", body: JSON.stringify({ name, phone }) }),
  saveNotificationPrefs: (prefs: NotificationPrefs) =>
    call<NotificationPrefs>("/tenant/notifications", { method: "PUT", body: JSON.stringify(prefs) }),
  newMaintenanceRequest: (title: string, description: string) =>
    call<MaintenanceRequest>("/tenant/maintenance", { method: "POST", body: JSON.stringify({ title, description }) }),
  /** 009: the signed lease and what the office shared, grouped by kind. */
  documents: () => call<{ groups: DocumentGroup[] }>("/tenant/documents").then((r) => r.groups),
  /** 009: notices the office wrote (rent and payment notices are on the Notices page already). */
  officeNotices: () => call<{ notices: OfficeNotice[] }>("/tenant/notices").then((r) => r.notices),
  markNoticeRead: (id: number) => call<{ ok: true }>(`/tenant/notices/${id}/read`, { method: "POST" }),
  /** 009: photos on these requests, by request number. */
  requestPhotos: (ids: number[]) =>
    ids.length
      ? call<{ attachments: Record<string, RequestPhoto[]> }>(`/tenant/maintenance/attachments?ids=${ids.join(",")}`).then((r) => r.attachments)
      : Promise.resolve({} as Record<string, RequestPhoto[]>),
  addRequestPhoto: (id: number, photo: { filename: string; data: string }) =>
    call<{ id: number }>(`/tenant/maintenance/${id}/attachments`, { method: "POST", body: JSON.stringify(photo) }),
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
    if (error.code === "AMOUNT_BELOW_BALANCE") {
      const owed = error.details?.balance;
      return `Pay at least the full balance${owed ? ` of ${formatCurrency(owed)}` : ""}. Partial payments aren't accepted.`;
    }
    if (error.code === "AMOUNT_ABOVE_LIMIT") {
      const max = error.details?.maximum;
      return max && max > 0
        ? `That's more than you can pay right now. The most is ${formatCurrency(max)} (up to ${error.details?.prepayMonths ?? 3} months of rent ahead).`
        : "You're already paid as far ahead as the portal allows.";
    }
    if (error.code === "ALREADY_REPORTED") return "Your last payment is still waiting for the office to confirm it. Once it's confirmed (or if it can't be matched) you'll see it here.";
    if (error.code === "METHOD_NOT_AVAILABLE") return "The office doesn't take that payment method right now. Choose another one.";
    if (error.code === "STRIPE_NOT_CONFIGURED") return "Card payments are not set up on this server yet.";
    if (error.code === "STRIPE_ERROR") {
      const message = error.details?.message ?? "The card payment could not start. Please try again.";
      return error.details?.stripeCode ? `${message} (Stripe: ${error.details.stripeCode})` : message;
    }
    if (error.code === "CARD_DECLINED") return error.details?.message ?? "Your card was declined. Try another card.";
    if (error.code === "CHECKOUT_AMOUNT_CHANGED") return "The amount changed. Please press Pay again.";
    if (error.code === "VALIDATION_ERROR") return "Check what you entered and try again.";
    if (error.code === "RATE_LIMITED") return "Too many attempts in a short time. Wait a few minutes and try again.";
    if (error.code === "FILE_INVALID") return "That photo couldn't be read. Upload a JPEG, PNG or WebP photo.";
    if (error.code === "FILE_TOO_LARGE") return "That photo is over 5 MB. Take a smaller photo or crop it.";
    if (error.code === "NOT_FOUND") return "That request or document is no longer available.";
  }
  return "Something went wrong. Please try again.";
}
