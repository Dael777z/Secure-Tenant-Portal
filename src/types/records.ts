import type { Role } from "./access"

/**
 * What the database layer returns: money in dollars, DATE columns as
 * "YYYY-MM-DD" strings, timestamps as Dates. User ids are "tenant:5" or
 * "admin:3" (utils/user-id.ts).
 */

// Accounts and sessions

export interface UserRecord {
    id: string
    email: string
    passwordHash: string
    role: Role
    /** Staff only. The schema has the flag; the app cannot verify a second factor yet. */
    mfaEnabled: boolean
}

/** Who a refresh token belonged to, after it was used up. */
export interface SessionUser {
    id: string
    email: string
    role: Role
}

/** A tenant the office has added who has not signed up yet. */
export interface InvitedTenant {
    id: string
    name: string
    email: string
    phone: string | null
}

export interface StaffProfile {
    name: string
    email: string
    role: string
}

// Properties, units, leases

export interface PropertyRecord {
    id: number
    name: string
    address: string
}

export interface UnitRecord {
    id: number
    propertyId: number
    propertyName: string
    unitNum: string
}

export interface LeaseRecord {
    id: number
    unitId: number
    startDate: string
    endDate: string | null
    monthlyRent: number
}

export interface LeaseWithUnit extends LeaseRecord {
    unitNum: string
    propertyId: number
    propertyName: string
    address: string
}

/** A tenant row (invited or signed up). */
export interface PersonRecord {
    id: number
    name: string
    email: string
    phone: string | null
    signedUp: boolean
}

/** One tenant on one lease. */
export interface LeaseResident {
    leaseId: number
    tenantId: number
    name: string
}

// Charges (owed) and payments (paid)

/** From the `lease_balance` view. Positive balance = the tenant owes. */
export interface LeaseBalance {
    leaseId: number
    charged: number
    paid: number
    refunded: number
    balance: number
}

export type ChargeKind = "rent" | "deposit" | "late_fee" | "utility" | "proration" | "other" | "parking" | "hoa" | "repair" | "non_compliance" | "misc_income"
    /** 010: the card processing fee, added by the system when a card payment completes (never by hand). */
    | "processing_fee"

export interface ChargeRecord {
    id: number
    leaseId: number
    kind: ChargeKind
    amount: number
    dueDate: string
    description: string | null
}

/**
 * A payment row. `direction` "charge" is money in, "refund" is money back out.
 * `confirmation` is the payment's transaction_id. `method` and `payerId` come
 * from Payment_Details (null if none was recorded).
 */
export interface PaymentRecord {
    id: number
    leaseId: number
    direction: "charge" | "refund"
    status: "pending" | "completed" | "failed"
    amount: number
    paidAt: Date
    method: string | null
    confirmation: string
    payerId: number | null
}

export interface RecentPaymentRecord {
    amount: number
    paidAt: Date
    method: string | null
    unitNum: string
    payer: string | null
}

/** A receipt file, already checked by the route (type matches its first bytes, at most 4 MB). */
export interface Receipt {
    filename: string
    contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
    data: Buffer
}

// Maintenance

/** New → In review → Scheduled → In progress → Completed (resolved). 008 added the two middle stages. */
export type MaintenanceState = "submitted" | "in_review" | "scheduled" | "in_progress" | "resolved" | "rejected"
export const MAINTENANCE_STATES: readonly MaintenanceState[] = ["submitted", "in_review", "scheduled", "in_progress", "resolved", "rejected"]
/** Completed or rejected (009): no longer in the open queue. */
export const isClosedState = (status: string): boolean => status === "resolved" || status === "rejected"
export type MaintenancePriority = "none" | "low" | "medium" | "high" | "emergency"
export const MAINTENANCE_PRIORITIES: readonly MaintenancePriority[] = ["none", "low", "medium", "high", "emergency"]
export type MaintenanceType = "appliance" | "plumbing" | "electrical" | "hvac" | "pest" | "locks" | "property" | "other"
export const MAINTENANCE_TYPES: readonly MaintenanceType[] = ["appliance", "plumbing", "electrical", "hvac", "pest", "locks", "property", "other"]

export interface MaintenanceRecord {
    id: number
    title: string
    description: string
    status: MaintenanceState
    priority: MaintenancePriority
    requestType: MaintenanceType
    /** YYYY-MM-DD */
    scheduledFor: string | null
    createdAt: Date
    updatedAt: Date
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
    tenantName: string | null
}

/** A request as the tenant sees it. Status stays a plain string so unknown values can fall back in the service. */
export interface TenantMaintenanceRecord {
    id: number
    title: string
    description: string
    status: string
    createdAt: Date
}

export interface OpenRequestCount {
    unitId: number
    count: number
}

// Bank accounts

export interface BankAccountRecord {
    id: number
    name: string
    mask: string | null
    subtype: string | null
}

// Messages (004)

export interface MessageRecord {
    id: number
    tenantId: number
    /** True when a property manager wrote it; false for the tenant. */
    fromOffice: boolean
    /** The manager's name when sent; null for the tenant's messages. */
    senderName: string | null
    body: string
    sentAt: Date
    /** When the other side opened the conversation; null until then. */
    readAt: Date | null
}

/** One tenant's conversation in the office inbox. */
export interface ThreadRecord {
    tenantId: number
    tenantName: string
    lastMessageAt: Date
    archived: boolean
    lastBody: string
    lastFromOffice: boolean
    /** The tenant's messages the office has not opened. */
    unread: number
    /** The tenant's current lease (or latest one), if any. */
    leaseId: number | null
    unitNum: string | null
    propertyName: string | null
}

// Card payments through Stripe (010)

export type PaymentState = PaymentRecord["status"]

/** A Payment that went through Stripe, with what Stripe last said about it. */
export interface StripePaymentRecord {
    payId: number
    leaseId: number
    tenantId: number | null
    paymentIntentId: string
    /** The ledger's status: only 'completed' moves the balance. */
    status: PaymentState
    /** Everything charged: rent + feeCents. */
    amountCents: number
    /** The processing fee inside amountCents. */
    feeCents: number
    /** The PaymentIntent's own status (requires_action, processing, succeeded, canceled, ...). */
    stripeStatus: string
    methodType: "card"
    /** Payment_Details.method, as the ledger shows it. */
    method: string | null
}

// Email notifications (011): who the emails go to, from the notify_* functions

export interface Recipient {
    name: string
    email: string
}

/** A lease behind on rent today: a line in the office's late-rent summary. */
export interface PastDueRecord {
    leaseId: number
    unitLabel: string
    tenantNames: string
    /** The oldest charge still unpaid. */
    dueDate: string
    balance: number
}

/** A lease ending soon, for the office. */
export interface LeaseEndingRecord {
    leaseId: number
    endDate: string
    unitLabel: string
    tenantNames: string
}

/** A notice's email, taken from the queue to send now. */
export interface QueuedNoticeEmail extends Recipient {
    id: number
    tenantId: number
    template: string
    subject: string
    body: string
}

/** What an office email is about (Office_Settings, 008, says which the office wants). */
export type OfficeEmailTopic = "message" | "maintenance" | "reported_payment" | "late_rent" | "lease_ending"
/** A tenant's email choices (006). */
export type TenantEmailChoice = "rent_due" | "payment_receipts" | "maintenance" | "messages"
