import type { Receipt } from "./records"

/** What the database layer accepts (the counterpart of records.ts). */

/** A sign-up invitation as stored: only the token's SHA-256 hash, never the token in the link. */
export interface HashExpiry {
    tokenHash: string
    expiresAt: Date
}

export interface NewRefreshToken {
    userId: string
    tokenHash: string
    expiresAt: Date
}

export interface NewTenant {
    name: string
    email: string
    phone?: string | null
    invite: HashExpiry
}

export interface TenantChanges {
    name: string
    phone: string | null
}

export interface PropertyInput {
    name: string
    address: string
}

export interface UnitInput {
    propertyId: number
    unitNum: string
}

export interface NewLease {
    unitId: number
    startDate: string
    endDate: string | null
    monthlyRent: number
    tenantIds: number[]
    newTenants: Array<{ name: string; email: string; phone: string | null; invite: HashExpiry }>
}

/** What a created lease gives back: its id, and the ids of the tenants it added (same order as `newTenants`). */
export interface CreatedLease {
    leaseId: number
    newTenantIds: number[]
}

export interface LeaseChanges {
    monthlyRent?: number
    /** `null` clears the end date (open-ended); leave out to keep it. */
    endDate?: string | null
}

export interface LeaseTenantInput {
    tenantId?: number
    newTenant?: { name: string; email: string; phone: string | null; invite: HashExpiry }
}

export interface NewPayment {
    leaseId: number
    amount: number
    /** Who paid. Null for an offline payment the office could not attribute. */
    tenantId: number | null
    /** Already formatted and trimmed to the column width by the caller. */
    method: string
    /** Becomes the payment's transaction_id (unique). */
    confirmation: string
    /** Office payments only. */
    receipt?: Receipt | null
    /**
     * Tenant payments: one per checkout, so a double click or a retried request
     * is recorded once (Payment.idempotency_key is unique).
     */
    idempotencyKey?: string | null
    /**
     * Cash App / Zelle (006): the tenant says they sent it. Recorded as
     * 'pending' (it does not move the balance) until the office confirms it.
     */
    reported?: { method: "cashapp" | "zelle" } | null
}

/** A charge the office adds by hand. Rent is billed by the rent job, so it is not one of these kinds. */
export type ManualChargeKind = "deposit" | "late_fee" | "utility" | "proration" | "parking" | "hoa" | "repair" | "non_compliance" | "misc_income" | "other"
export const MANUAL_CHARGE_KINDS: readonly ManualChargeKind[] = ["deposit", "late_fee", "utility", "proration", "parking", "hoa", "repair", "non_compliance", "misc_income", "other"]

export interface NewCharge {
    leaseId: number
    kind: ManualChargeKind
    amount: number
    /** YYYY-MM-DD */
    dueDate: string
    description: string | null
}

export interface NewMaintenance {
    unitId: number
    /** Null when the office files it. */
    tenantId: number | null
    title: string
    description: string
    priority?: import("./records").MaintenancePriority
    requestType?: import("./records").MaintenanceType
}

/** What the office may change on a request (008); anything left out stays. */
export interface MaintenanceChange {
    status?: import("./records").MaintenanceState
    priority?: import("./records").MaintenancePriority
    requestType?: import("./records").MaintenanceType
    /** YYYY-MM-DD, or null to clear it. */
    scheduledFor?: string | null
}

export interface BankItem {
    itemId: string
    accessTokenEnc: string
}

export interface BankAccountInput {
    accountId: string
    name: string
    mask: string | null
    subtype: string | null
}

// Card payments through Stripe (010)

/** A card as Stripe shows it (never the number). `wallet`: apple_pay, google_pay, ... or null for a typed-in card. */
export interface CardDetails {
    brand: string | null
    last4: string | null
    funding: string | null
    wallet: string | null
}

/** A tenant's checkout, written 'pending' before Stripe finishes it. */
export interface NewStripePayment {
    leaseId: number
    tenantId: number
    /** Everything charged, fee included. */
    amount: number
    /** The processing fee inside `amount`, in cents. */
    feeCents: number
    paymentIntentId: string
    methodType: "card"
    /** Payment_Details.method: "Visa •••• 4242", "Apple Pay (Visa •••• 4242)". */
    method: string
    /** What Stripe shows of the card. */
    card?: CardDetails | null
    stripeStatus: string
    /** Scoped to the tenant ("tenant:<id>:<key>"): one checkout, one Payment row. */
    idempotencyKey: string
}

/** What Stripe says about a PaymentIntent now, and the ledger status that follows from it. */
export interface StripePaymentUpdate {
    paymentIntentId: string
    status: import("./records").PaymentState
    stripeStatus: string
    amountReceivedCents: number
    currency: string
    failureMessage: string | null
    /** "YYYY-MM-DD": the due date of the processing-fee charge, if this update completes the payment. */
    today: string
}

/** A refund made in Stripe, recorded as a 'refund' Payment row on the same lease. */
export interface NewStripeRefund {
    paymentIntentId: string
    refundId: string
    amount: number
}
