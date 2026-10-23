import type { NotificationPrefs, OfficeSettingsRecord, ReportedPaymentRecord } from "./settings"
import type { ExpenseRecord, LeaseLocation, MaintenanceTiming, NewExpense, RenewalNoticeRecord } from "./finance"
import type {
    BankAccountInput, BankItem, CreatedLease, NewCharge, HashExpiry, LeaseChanges, LeaseTenantInput, NewLease,
    NewMaintenance, NewPayment, NewRefreshToken, NewTenant, PropertyInput, TenantChanges, UnitInput,
} from "./inputs"
import type {
    BankAccountRecord, ChargeRecord, InvitedTenant, LeaseBalance, LeaseRecord, LeaseResident, LeaseWithUnit,
    MaintenanceRecord, MaintenanceState, MessageRecord, OpenRequestCount, PaymentRecord, PersonRecord, PropertyRecord, Receipt,
    RecentPaymentRecord, SessionUser, StaffProfile, TenantMaintenanceRecord, ThreadRecord, UnitRecord, UserRecord,
} from "./records"

/**
 * The database contract, one interface per area. db/postgres-db.ts implements
 * all of them; each service declares only the slice it uses, so its fakes in
 * tests stay small. Dates passed as `today` are "YYYY-MM-DD".
 *
 * Nothing is deleted: the app's login has no DELETE grant (except on
 * Lease_Tenants), so "deactivate" retires a row and every list skips it, and
 * payments are corrected with a new row rather than edited.
 */

export interface HealthStore {
    checkHealth(): Promise<void>
}

export interface AccountStore {
    /** Someone who can sign in: staff, or a tenant who finished signing up. */
    findUserByEmail(email: string): Promise<UserRecord | null>
    /** Use up an open invitation (by token hash) and set the password. Null if none matches. */
    completeSignup(tokenHash: string, passwordHash: string): Promise<UserRecord | null>
    findStaffProfile(adminId: number): Promise<StaffProfile | null>
}

export interface SessionStore {
    storeRefreshToken(data: NewRefreshToken): Promise<void>
    /** Revoke the token and return its owner, in one statement. Null if unknown, used, expired or the account is inactive. */
    consumeRefreshToken(tokenHash: string): Promise<SessionUser | null>
    revokeRefreshToken(tokenHash: string): Promise<void>
    revokeAllTokensForUser(userId: string): Promise<void>
}

export interface PropertyStore {
    listProperties(): Promise<PropertyRecord[]>
    countProperties(): Promise<number>
    listUnits(propertyId?: number): Promise<UnitRecord[]>
    /** Insert when `id` is null, otherwise update. Returns the id. */
    saveProperty(id: number | null, input: PropertyInput): Promise<number>
    saveUnit(id: number | null, input: UnitInput): Promise<number>
    /** UNIT_HAS_LEASES while it has a current or future lease. */
    deactivateUnit(uID: number, today: string): Promise<void>
    /** Retires its units too. PROPERTY_HAS_LEASES while any has a current or future lease. */
    deactivateProperty(pID: number, today: string): Promise<void>
}

export interface PeopleStore {
    listPeople(): Promise<PersonRecord[]>
    findPerson(tID: number): Promise<PersonRecord | null>
    /** A tenant with an invitation and no password yet. EMAIL_IN_USE on a duplicate. */
    inviteTenant(data: NewTenant): Promise<InvitedTenant>
    /** Replace the invitation of a tenant who has not signed up. */
    reissueInvite(tID: number, invite: HashExpiry): Promise<void>
    /**
     * A signed-up tenant who forgot their password: clear it, sign them out
     * everywhere, and leave a new link (the invite token) as the only way back in.
     * TENANT_NOT_SIGNED_UP for someone still invited (send the invite again instead).
     */
    resetSignIn(tID: number, invite: HashExpiry): Promise<void>
    updateTenant(tID: number, changes: TenantChanges): Promise<void>
    /** Also signs them out everywhere. TENANT_ON_LEASE while on a current or future lease. */
    deactivateTenant(tID: number, today: string): Promise<void>
}

export interface LeaseStore {
    listLeases(): Promise<LeaseRecord[]>
    findLease(leaseId: number): Promise<LeaseWithUnit | null>
    /** The tenant's lease that is in effect on `today`. */
    findCurrentLease(tID: number, today: string): Promise<LeaseWithUnit | null>
    listLeaseResidents(): Promise<LeaseResident[]>
    listLeaseTenants(leaseId: number): Promise<PersonRecord[]>
    /** Adds the new tenants, the lease and its rent due so far, together. UNIT_OCCUPIED on an overlap. */
    createLease(input: NewLease, today: string): Promise<CreatedLease>
    updateLease(leaseId: number, changes: LeaseChanges): Promise<void>
    /** Returns the tenant's id. */
    addTenantToLease(leaseId: number, input: LeaseTenantInput): Promise<number>
    /** A lease keeps at least one tenant. */
    removeTenantFromLease(leaseId: number, tID: number): Promise<void>
}

export interface LedgerStore {
    /** Every lease's totals, from the `lease_balance` view. */
    listLeaseBalances(): Promise<LeaseBalance[]>
    listChargesForLease(leaseId: number): Promise<ChargeRecord[]>
    /** Add the missing monthly rent charges up to `today`. Safe to repeat. Returns how many it added. */
    generateRentCharges(today: string, leaseId?: number): Promise<number>
    /** A late fee, deposit, utility bill, proration or other charge on a lease. Returns its id. */
    addCharge(input: NewCharge): Promise<number>
}

export interface PaymentStore {
    listPaymentsForLease(leaseId: number): Promise<PaymentRecord[]>
    /** Completed payments in, newest first. */
    listRecentPayments(limit: number): Promise<RecentPaymentRecord[]>
    listReceiptPaymentIds(leaseId: number): Promise<number[]>
    /**
     * A completed payment and its receipt, together. A tenant may only pay on their own lease.
     * Returns the confirmation on record: the new one, or, when the idempotency key was
     * already used on this lease, the first payment's (nothing new is written).
     */
    recordPayment(input: NewPayment): Promise<{ confirmation: string }>
    /** The confirmation of the payment already recorded on this lease under this idempotency key, if any. */
    findConfirmationByKey(leaseId: number, idempotencyKey: string): Promise<string | null>
    /** Adds a matching refund. NOT_OFFICE_PAYMENT for a tenant's payment, PAYMENT_ALREADY_REVERSED the second time. */
    reverseOfficePayment(leaseId: number, payId: number): Promise<void>
    attachReceipt(leaseId: number, payId: number, receipt: Receipt): Promise<void>
    findReceipt(leaseId: number, payId: number): Promise<Receipt | null>
}

export interface MaintenanceStore {
    /** Unresolved first. */
    listMaintenance(): Promise<MaintenanceRecord[]>
    /** Requests on the units the tenant leases now. */
    listTenantMaintenance(tID: number): Promise<TenantMaintenanceRecord[]>
    listOpenRequestCounts(): Promise<OpenRequestCount[]>
    createMaintenance(input: NewMaintenance): Promise<{ id: number; createdAt: Date }>
    setMaintenanceStatus(id: number, status: MaintenanceState): Promise<void>
    deactivateMaintenance(mID: number): Promise<void>
}

export interface BankStore {
    listBankAccounts(tID: number): Promise<BankAccountRecord[]>
    /** Only finds the tenant's own account. */
    findBankAccount(tID: number, bID: number): Promise<BankAccountRecord | null>
    saveBankAccounts(tID: number, item: BankItem, accounts: BankAccountInput[]): Promise<void>
}

export interface MessageStore {
    /** The office inbox (or the archived conversations), most recent first. */
    listThreads(archived: boolean, today: string): Promise<ThreadRecord[]>
    /** Null when the tenant has no conversation yet. */
    findThread(tID: number, today: string): Promise<ThreadRecord | null>
    /** Oldest first. */
    listMessages(tID: number): Promise<MessageRecord[]>
    /** `adminId` null: the tenant is writing. The conversation is made on its first message. */
    sendMessage(input: { tenantId: number; adminId: number | null; body: string }): Promise<MessageRecord>
    /** The receipt: mark what `writtenBy` sent and the other side has not opened. Returns how many. */
    markMessagesRead(tID: number, writtenBy: "tenant" | "office"): Promise<number>
    /** NOT_FOUND when the tenant has no conversation. */
    setThreadArchived(tID: number, archived: boolean): Promise<void>
    /** Conversations in the inbox with a tenant message the office has not opened. */
    countUnreadThreads(): Promise<number>
}

/** Juan's tenant side (006): reported Cash App / Zelle payments, office handles, tenant settings. */
export interface SettingsStore {
    getOfficeSettings(): Promise<OfficeSettingsRecord>
    /** Property managers only. */
    updateOfficeSettings(input: { cashappHandle: string | null; zelleHandle: string | null }): Promise<void>
    /** The defaults (everything on) when the tenant has not chosen. */
    getNotificationPrefs(tID: number): Promise<NotificationPrefs>
    saveNotificationPrefs(tID: number, prefs: NotificationPrefs): Promise<void>
    /** As the signed-in tenant: their own name and phone, nothing else. NOT_FOUND if that fails. */
    updateOwnProfile(input: { name: string; phone: string | null }): Promise<void>
    /** Newest first. `leaseId` limits to one lease; `pendingOnly` to the ones waiting for the office. */
    listReportedPayments(filter?: { leaseId?: number; pendingOnly?: boolean }): Promise<ReportedPaymentRecord[]>
    /** Confirm (the payment completes) or reject (it fails, with a reason). NOT_FOUND unless it is pending. */
    reviewReportedPayment(payId: number, decision: "confirmed" | "rejected", reason: string | null): Promise<ReportedPaymentRecord>
}

export type AuthStore = AccountStore & SessionStore

export type TenantStore =
    & Pick<PeopleStore, "findPerson">
    & Pick<LeaseStore, "findCurrentLease">
    & Pick<LedgerStore, "listChargesForLease">
    & Pick<PaymentStore, "listPaymentsForLease" | "recordPayment" | "findConfirmationByKey">
    & Pick<MaintenanceStore, "listTenantMaintenance" | "createMaintenance">
    & BankStore
    & Pick<SettingsStore, "getOfficeSettings" | "getNotificationPrefs" | "saveNotificationPrefs" | "updateOwnProfile" | "listReportedPayments">

export type ManagerStore =
    & PropertyStore & PeopleStore & LeaseStore & LedgerStore & PaymentStore & MaintenanceStore
    & Pick<AccountStore, "findStaffProfile">
    & Pick<SettingsStore, "listReportedPayments">

export type MessagingStore = MessageStore & Pick<PeopleStore, "findPerson"> & Pick<LeaseStore, "findCurrentLease">

/** Finance, collections, P&L and performance (005). Staff ('admin') only. */
export interface FinanceStore {
    /** Every charge on every lease, oldest due first. */
    listAllCharges(): Promise<ChargeRecord[]>
    /** Every payment and refund on every lease, oldest first. */
    listAllPayments(): Promise<PaymentRecord[]>
    /** Every lease and where it is, retired units included. */
    listLeaseLocations(): Promise<LeaseLocation[]>
    /** Expenses that are not voided, newest first. */
    listExpenses(): Promise<ExpenseRecord[]>
    /** Returns its id. VALIDATION_ERROR when the unit is not in the property. */
    addExpense(input: NewExpense): Promise<number>
    /** NOT_FOUND when unknown or already voided. */
    voidExpense(expId: number): Promise<void>
    listMaintenanceTimings(): Promise<MaintenanceTiming[]>
    /** The newest notice per lease. */
    listRenewalNotices(): Promise<RenewalNoticeRecord[]>
    recordRenewalNotice(leaseId: number, recipients: number): Promise<void>
    /** When the office last wrote to each tenant. */
    listLastOfficeMessages(): Promise<Array<{ tenantId: number; at: Date }>>
}

export type FinanceDataStore =
    & FinanceStore
    & Pick<PropertyStore, "listProperties" | "listUnits">
    & Pick<PeopleStore, "listPeople">
    & Pick<LeaseStore, "listLeases" | "listLeaseResidents" | "findLease" | "listLeaseTenants">
    & Pick<LedgerStore, "listLeaseBalances">
    & Pick<MessageStore, "sendMessage">
    & Pick<SettingsStore, "getOfficeSettings" | "updateOfficeSettings" | "listReportedPayments" | "reviewReportedPayment">

/** The whole database. */
export type DatabaseInterface =
    & HealthStore & AccountStore & SessionStore & PropertyStore & PeopleStore
    & LeaseStore & LedgerStore & PaymentStore & MaintenanceStore & BankStore & MessageStore & FinanceStore & SettingsStore
