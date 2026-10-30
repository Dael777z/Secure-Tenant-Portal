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
    /** Cash App Pay through Stripe (006): false when STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY are not set. */
    cashAppEnabled: boolean
    /** For Stripe.js in the browser; null when Stripe is off. */
    stripePublishableKey: string | null
    /** The processing fee Cash App Pay adds (2.9% = 290 basis points, + fixed cents); null when it is off. */
    cashAppFee: { basisPoints: number; fixedCents: number } | null
}
