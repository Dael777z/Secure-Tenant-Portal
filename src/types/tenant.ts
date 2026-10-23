import type { NotificationPrefs, TenantReportedPayment } from "./settings"

// What the tenant API returns. These match frontend/src/types/index.ts; dates
// come formatted for display ("Oct 1, 2026").

export interface TenantProfile {
    id: string
    name: string
    initials: string
    unitLabel: string
    address: string
}

export interface LedgerEntry {
    id: string
    date: string
    description: string
    method: string | null
    /** Charges negative, payments positive. */
    amount: number
    /** What was owed after this line. */
    balanceAfter: number
    confirmation?: string
}

export type MaintenanceStatus = "open" | "in_progress" | "resolved"

export interface MaintenanceRequest {
    id: string
    title: string
    description: string
    submittedDate: string
    status: MaintenanceStatus
}

export interface Notice {
    id: string
    type: "payment" | "due" | "maintenance"
    title: string
    body: string
    nextStep: string
    timestamp: string
}

export interface LinkedBankAccount {
    id: string
    name: string
    mask: string | null
    subtype: string | null
}

export interface TenantSummary {
    tenant: TenantProfile
    /** The tenant's own contact details (Settings). The email is their sign-in. */
    contact: { email: string; phone: string | null }
    /** Where to send Cash App / Zelle payments; null when the office has not set one up. */
    payOptions: { cashapp: string | null; zelle: string | null }
    /** Cash App / Zelle payments the tenant reported: waiting, and recent decisions. */
    reportedPayments: TenantReportedPayment[]
    notificationPrefs: NotificationPrefs
    currentBalance: number
    rentDueDate: string
    lateFeeGraceDate: string
    ledger: LedgerEntry[]
    maintenanceRequests: MaintenanceRequest[]
    notices: Notice[]
    bankAccounts: LinkedBankAccount[]
    /** False when PLAID_CLIENT_ID / PLAID_SECRET are not set. */
    plaidEnabled: boolean
    /** Development only: a payment without a linked bank account is recorded as a test transfer. Never in production. */
    testPayments: boolean
}
