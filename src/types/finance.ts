// Finance, collections, profit & loss and performance (005). Money is in
// dollars; dates are "YYYY-MM-DD" unless a field says it is an ISO timestamp.

export const EXPENSE_CATEGORIES = [
    "repairs", "utilities", "insurance", "taxes", "mortgage", "management", "supplies", "legal", "marketing", "other",
] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

// ---- Records (what the store returns)

export interface ExpenseRecord {
    id: number
    propertyId: number | null
    propertyName: string | null
    unitId: number | null
    unitNum: string | null
    category: ExpenseCategory
    amount: number
    spentOn: string
    vendor: string | null
    description: string | null
    /** The manager who entered it. */
    createdBy: string | null
}

export interface NewExpense {
    propertyId: number | null
    unitId: number | null
    category: ExpenseCategory
    amount: number
    spentOn: string
    vendor: string | null
    description: string | null
}

/** Every lease with where it is, including leases on retired units (history still counts). */
export interface LeaseLocation {
    leaseId: number
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
}

export interface MaintenanceTiming {
    id: number
    unitId: number
    status: "submitted" | "in_progress" | "resolved"
    createdAt: Date
    /** When it last moved to resolved (Maintenance_Status_History); null while open. */
    resolvedAt: Date | null
}

export interface RenewalNoticeRecord {
    leaseId: number
    sentAt: Date
    recipients: number
}

// ---- What the API answers

export type FinancePeriod = "this-month" | "30d" | "90d" | "ytd" | "12m"

export interface PeriodInfo {
    key: FinancePeriod
    label: string
    from: string
    to: string
}

export interface ResidentContact {
    id: number
    name: string
    email: string
    phone: string | null
}

/** Unpaid amounts by how long past their due date they are, as of today. */
export interface AgingBuckets {
    /** Not yet late (due today, inside the grace period, or due later). */
    current: number
    d1_30: number
    d31_60: number
    d61_90: number
    d90plus: number
    total: number
}

export interface CollectionRow extends AgingBuckets {
    leaseId: number
    unitLabel: string
    propertyId: number
    propertyName: string
    tenants: ResidentContact[]
    monthlyRent: number
    /** The ledger balance (charged - paid + refunded). */
    balance: number
    /** Unapplied money the tenant paid ahead (balance below zero). */
    credit: number
    /** The oldest charge with something still unpaid. */
    oldestUnpaidDue: string | null
    daysLate: number
    /** How many months of rent the late amount is. */
    monthsBehind: number
    lastPayment: { amount: number; paidAt: string } | null
    /** Late fees already billed on this lease. */
    lateFeesBilled: number
    /** When the office last messaged a resident on this lease (ISO), if ever. */
    lastContactAt: string | null
    ended: boolean
}

export interface RecentPaymentRow {
    id: number
    leaseId: number
    payer: string
    unitLabel: string
    propertyName: string
    amount: number
    /** ISO timestamp. */
    paidAt: string
    method: string | null
    confirmation: string
    /** paid: covered the charge(s) it went to; partial: left part of one open; prepaid: nothing was due; refund: money back out. */
    status: "paid" | "partial" | "prepaid" | "refund"
    /** The charge it was applied to first, if any. */
    forCharge: { kind: string; dueDate: string } | null
}

export interface MonthRow {
    /** "2026-10" */
    month: string
    label: string
    billed: number
    collected: number
    expenses: number
    net: number
}

export interface IncomeLine {
    category: string
    label: string
    billed: number
    collected: number
}

export interface ExpenseLine {
    category: ExpenseCategory
    label: string
    amount: number
}

export interface ProfitAndLoss {
    income: IncomeLine[]
    /** Money in that went to no charge yet (paid ahead). */
    prepaid: number
    refunds: number
    totalBilled: number
    totalCollected: number
    expenses: ExpenseLine[]
    totalExpenses: number
    netOperatingIncome: number
    /** NOI / collected, 0..1 (0 when nothing was collected). */
    margin: number
    byProperty: Array<{ propertyId: number | null; name: string; billed: number; collected: number; expenses: number; net: number }>
}

export interface FinanceOverview {
    asOf: string
    /** A charge is late this many days after its due date. */
    lateAfterDays: number
    period: PeriodInfo
    summary: {
        chargesDue: number
        paid: number
        /** Unpaid, not late yet. */
        open: number
        late: number
        /** paid / chargesDue, 0..1 */
        collectedRate: number
        /** Payments received in the period, less refunds (cash basis). */
        cashCollected: number
        refunds: number
        expenses: number
        net: number
    }
    aging: AgingBuckets & { accounts: number }
    collections: CollectionRow[]
    recentPayments: RecentPaymentRow[]
    monthly: MonthRow[]
    pnl: ProfitAndLoss
    expenses: ExpenseRow[]
}

export type ExpenseRow = ExpenseRecord

export interface MonthTrend {
    month: string
    label: string
    billed: number
    collected: number
    /** collected / billed for charges due that month, 0..1 */
    collectionRate: number
    expenses: number
    noi: number
    /** Leased units / active units at month end (today for the current month), 0..1 */
    occupancy: number
}

export interface PropertyPerformance {
    id: number
    name: string
    units: number
    occupied: number
    occupancy: number
    rentRoll: number
    avgRent: number
    billed12m: number
    collected12m: number
    collectionRate: number
    expenses12m: number
    noi12m: number
    outstanding: number
    openMaintenance: number
    expiring90: number
}

export interface Analytics {
    asOf: string
    lateAfterDays: number
    kpis: {
        units: number
        occupied: number
        vacant: number
        occupancy: number
        rentRoll: number
        avgRent: number
        billed12m: number
        collected12m: number
        collectionRate12m: number
        expenses12m: number
        noi12m: number
        outstanding: number
        /** outstanding / monthly rent roll */
        delinquencyRate: number
        /** Share of rent charges (last 12 months, already past their grace period) paid on time, 0..1 */
        onTimeRate: number
        /** Average days from due date to paid in full, for rent paid in the last 12 months. */
        avgDaysToPay: number
        openMaintenance: number
        avgResolutionDays: number | null
        expiring90: number
    }
    trend: MonthTrend[]
    properties: PropertyPerformance[]
    maintenance: { submitted: number; inProgress: number; resolved12m: number; avgResolutionDays: number | null; oldestOpenDays: number | null }
}

export interface ExpiringLeaseRow {
    leaseId: number
    unitLabel: string
    propertyId: number
    propertyName: string
    tenants: ResidentContact[]
    endDate: string
    daysLeft: number
    monthlyRent: number
    balance: number
    lastNotice: { sentAt: string; recipients: number } | null
}
