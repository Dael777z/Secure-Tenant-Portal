// Juan's tenant side (006): Cash App / Zelle payments the tenant reports and
// the office confirms, the office's payment handles, tenant notification
// choices and the tenant's own contact details.

export type ManualPayMethod = "cashapp" | "zelle"
export const MANUAL_PAY_METHODS: readonly ManualPayMethod[] = ["cashapp", "zelle"]
export const MANUAL_PAY_LABELS: Record<ManualPayMethod, string> = { cashapp: "Cash App", zelle: "Zelle" }

/** What the property manager sets on Payment options. */
export interface OfficeSettingsInput {
    cashappHandle: string | null
    zelleHandle: string | null
    zellePhone: string | null
    requirePaymentRef: boolean
}

export interface OfficeSettingsRecord {
    cashappHandle: string | null
    /** The email address the office's Zelle is enrolled with (013: the phone number is zellePhone). */
    zelleHandle: string | null
    zellePhone: string | null
    /** When each QR code was uploaded (012, 013); null when there is none. */
    cashappQrAt: Date | null
    zelleQrAt: Date | null
    /** 013: a reported payment must carry its confirmation number (the screenshot always is). */
    requirePaymentRef: boolean
    updatedAt: Date | null
    /** The manager who last changed them. */
    updatedBy: string | null
}

export interface NotificationPrefs {
    rentDue: boolean
    paymentReceipts: boolean
    maintenance: boolean
    messages: boolean
}
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { rentDue: true, paymentReceipts: true, maintenance: true, messages: true }

/** A Cash App / Zelle payment a tenant said they sent, and what the office decided. */
export interface ReportedPaymentRecord {
    id: number
    leaseId: number
    amount: number
    method: ManualPayMethod
    reportedAt: Date
    reportedBy: number
    reportedByName: string
    confirmation: string
    /** pending: waiting for the office; completed: confirmed; failed: rejected. */
    status: "pending" | "completed" | "failed"
    decision: "confirmed" | "rejected" | null
    reason: string | null
    reviewedAt: Date | null
    reviewedBy: string | null
    /** 012: the payment's identifier in the tenant's app, and whether they attached a screenshot. */
    transactionRef: string | null
    hasProof: boolean
}

// ---- What the API answers

/** On the tenant summary. */
export interface TenantReportedPayment {
    id: number
    method: ManualPayMethod
    amount: number
    /** "Oct 23, 2026" */
    reportedOn: string
    status: "pending" | "confirmed" | "rejected"
    reason: string | null
}

/** The manager's "Awaiting confirmation" list. */
export interface ReportedPaymentRow {
    id: number
    leaseId: number
    unitLabel: string
    propertyName: string
    tenantName: string
    method: ManualPayMethod
    amount: number
    /** ISO timestamp. */
    reportedAt: string
    confirmation: string
    /** The lease's balance now (the report does not count until it is confirmed). */
    balance: number
    status: "pending" | "confirmed" | "rejected"
    reason: string | null
    reviewedAt: string | null
    reviewedBy: string | null
    /** 012: the payment's identifier in the tenant's app; the screenshot is at /manager/payments/:id/proof. */
    transactionRef: string | null
    hasProof: boolean
}

export interface OfficeSettings {
    cashappHandle: string | null
    zelleHandle: string | null
    zellePhone: string | null
    /** ISO time each QR code was uploaded; null when there is none. */
    cashappQrAt: string | null
    zelleQrAt: string | null
    requirePaymentRef: boolean
    updatedAt: string | null
    updatedBy: string | null
}
