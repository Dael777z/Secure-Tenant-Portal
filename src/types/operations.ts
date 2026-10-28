// RentRedi-style management features (008): late fee rules, rent reminders,
// lease documents, the unit page, Rent & Charges, staff and office notifications.

export type FeeType = "flat" | "percent"

/** A rule's scope: everything (no property), a property, or one unit. */
export interface RuleScope {
    propertyId: number | null
    unitId: number | null
}

export interface LateFeeRuleRecord extends RuleScope {
    id: number
    graceDays: number
    firstAmount: number
    firstType: FeeType
    dailyAmount: number
    dailyType: FeeType
    maxAmount: number | null
    maxType: FeeType
    createdAt: Date
    createdBy: string | null
}
export type NewLateFeeRule = Omit<LateFeeRuleRecord, "id" | "createdAt" | "createdBy">

export interface ReminderRuleRecord extends RuleScope {
    id: number
    daysBefore: number
    repeatAfterDue: boolean
    createdAt: Date
    createdBy: string | null
}
export type NewReminderRule = Omit<ReminderRuleRecord, "id" | "createdAt" | "createdBy">

export interface ReminderSentRecord {
    /** Null for a "coming up" reminder: that month is not billed yet. */
    chargeId: number | null
    leaseId: number
    sentOn: string
    kind: "upcoming" | "due" | "overdue"
    amount: number
    dueDate: string
    description: string | null
}

/** The signed lease PDF on file for a lease (never the file itself). */
export interface LeaseDocumentMeta {
    leaseId: number
    filename: string
    sizeBytes: number
    uploadedAt: Date
    uploadedBy: string | null
}

export interface LeaseDocumentFile {
    filename: string
    contentType: string
    data: Buffer
}

export interface StaffMember {
    id: number
    name: string
    email: string
    role: string
}

export interface OfficeNotifications {
    notifyEmail: string | null
    newMaintenance: boolean
    tenantMessage: boolean
    reportedPayment: boolean
    lateRent: boolean
}

// ---- What the API answers

export interface ScopeLabel {
    /** "All properties", "Woodcrest Apartments", "Unit 101 - Woodcrest Apartments" */
    label: string
    propertyId: number | null
    unitId: number | null
}

export interface LateFeeRuleRow extends ScopeLabel {
    id: number
    graceDays: number
    firstAmount: number
    firstType: FeeType
    dailyAmount: number
    dailyType: FeeType
    maxAmount: number | null
    maxType: FeeType
    createdAt: string
    createdBy: string | null
}

export interface ReminderRuleRow extends ScopeLabel {
    id: number
    daysBefore: number
    repeatAfterDue: boolean
    createdAt: string
    createdBy: string | null
}

/** Every unit with the rule that applies to it (Late Fee Rules / Rent Reminders tables). */
export interface UnitRuleRow {
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
    /** null: no rule covers this unit. */
    ruleId: number | null
    /** Where the rule comes from. */
    source: "unit" | "property" | "all" | null
}

export interface ReminderSentRow {
    chargeId: number | null
    leaseId: number
    unitLabel: string
    tenants: string[]
    sentOn: string
    kind: "upcoming" | "due" | "overdue"
    amount: number
    dueDate: string
}

/** One charge on Rent & Charges. */
export interface ChargeViewRow {
    id: number
    leaseId: number
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
    tenants: Array<{ id: number; name: string }>
    kind: string
    kindLabel: string
    description: string
    dueDate: string
    amount: number
    paid: number
    unpaid: number
    status: "paid" | "due" | "late"
    /** How it was paid: by the office (manual), by the tenant (online), both, or not yet. */
    source: "manual" | "online" | "both" | null
    paidOn: string | null
}

export interface ChargesView {
    from: string
    to: string
    summary: { charged: number; paid: number; due: number; late: number }
    /** Unpaid and past due, any month. */
    allTimeLate: number
    rows: ChargeViewRow[]
}

export interface UnitLeaseRow {
    id: number
    startDate: string
    endDate: string | null
    monthlyRent: number
    tenants: Array<{ id: number; name: string }>
    balance: number
    state: "current" | "upcoming" | "ended"
    document: { filename: string; uploadedAt: string } | null
}

export interface UnitDetail {
    id: number
    unitNum: string
    propertyId: number
    propertyName: string
    address: string
    /** The lease running today (or the next one starting). */
    leaseId: number | null
    leases: UnitLeaseRow[]
    performance: {
        /** Last 12 months on this unit. */
        billed: number
        collected: number
        collectionRate: number | null
        onTimeRate: number | null
        monthsLeased: number
        openRequests: number
    }
    maintenance: Array<{ id: number; title: string; status: string; priority: string; submittedDate: string }>
}

export interface DocumentRow {
    kind: "lease" | "receipt"
    leaseId: number
    unitLabel: string
    tenants: string[]
    filename: string
    sizeBytes: number
    uploadedAt: string
    uploadedBy: string | null
    /** Receipts: the payment it belongs to. */
    paymentId: number | null
}
