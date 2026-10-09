// What the tenant API returns: the shapes Juan's pages already use
// (frontend/src/types/index.ts), so the pages need no new types. Dates come
// pre-formatted the way his mock data writes them ("Oct 1, 2026").

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
    /** Juan's convention: charges negative, payments positive. */
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
    /** False when PLAID_CLIENT_ID / PLAID_SECRET are not set: payments are recorded as a demo transfer. */
    plaidEnabled: boolean
}
