// What the manager API returns. Money is in dollars, as in Angel's NUMERIC columns.
import type { LedgerEntry } from "./tenant"

export interface PropertySummary {
    id: number
    name: string
    address: string
    units: number
    occupied: number
    monthlyRent: number
    outstanding: number
}

export interface UnitRow {
    id: number
    propertyId: number
    propertyName: string
    unitNum: string
    leaseId: number | null
    tenants: Array<{ id: number; name: string }>
    monthlyRent: number | null
    balance: number
    startDate: string | null
    endDate: string | null
    status: "vacant" | "current" | "owing"
    openRequests: number
}

export interface TenantRow {
    id: number
    name: string
    email: string
    phone: string | null
    signedUp: boolean
    leaseId: number | null
    unitLabel: string | null
    balance: number
}

export interface LeaseDetail {
    id: number
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
    address: string
    startDate: string
    endDate: string | null
    monthlyRent: number
    tenants: Array<{ id: number; name: string; email: string; phone: string | null; signedUp: boolean }>
    balance: number
    ledger: LedgerEntry[]
    /** payIDs (the number in a ledger entry's "payment-<id>") that have a receipt on file. */
    receiptPaymentIds: number[]
}

export interface MaintenanceRow {
    id: number
    title: string
    description: string
    status: "submitted" | "in_progress" | "resolved"
    submittedDate: string
    unitId: number
    unitNum: string
    propertyName: string
    tenantName: string | null
}

export interface UpdateRow {
    kind: "overdue" | "maintenance_new" | "not_signed_up"
    title: string
    detail: string
    leaseId: number | null
    unitLabel: string
    amount: number | null
    severity: number
}

export interface DashboardData {
    properties: number
    units: number
    occupied: number
    vacant: number
    expectedThisMonth: number
    collectedThisMonth: number
    outstanding: number
    overdueAccounts: number
    openMaintenance: number
    recentActivity: Array<{ kind: "payment" | "maintenance"; title: string; detail: string; when: string; at: string }>
    updates: UpdateRow[]
}
