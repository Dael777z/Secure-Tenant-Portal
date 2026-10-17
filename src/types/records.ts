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

export type ChargeKind = "rent" | "deposit" | "late_fee" | "utility" | "proration" | "other"

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
