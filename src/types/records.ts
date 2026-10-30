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
    /** Email this manager when a tenant files a maintenance request (005). */
    notifyMaintenance: boolean
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

export type ChargeKind = "rent" | "deposit" | "late_fee" | "utility" | "proration" | "other" | "processing_fee"

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

export type MaintenanceState = "submitted" | "in_progress" | "resolved"

export interface MaintenanceRecord {
    id: number
    title: string
    description: string
    status: MaintenanceState
    createdAt: Date
    unitId: number
    unitNum: string
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

// Notifications (005): who the scheduled emails go to, from the notify_* functions

export interface Recipient {
    name: string
    email: string
}

/** A tenant on a lease in effect today: the 1st-of-the-month rent email. */
export interface RentDueRecord extends Recipient {
    tenantId: number
    leaseId: number
    unitLabel: string
    monthlyRent: number
    balance: number
}

/** A tenant whose lease's oldest unpaid charge is past its due date. */
export interface PastDueRecord extends Recipient {
    tenantId: number
    leaseId: number
    unitLabel: string
    chargeId: number
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

// Stripe payments (006)

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
    /** The processing fee inside amountCents (007); 0 for payments from before fees. */
    feeCents: number
    /** The PaymentIntent's own status (requires_action, processing, succeeded, canceled, ...). */
    stripeStatus: string
}
