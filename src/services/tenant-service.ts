import { silentLogger, type LogService } from "../logging"
import { AppError } from "../types/errors"
import type { BankAccountInput, BankItem } from "../types/inputs"
import type { TenantStore } from "../types/stores"
import { MANUAL_PAY_LABELS, type ManualPayMethod, type NotificationPrefs, type TenantReportedPayment } from "../types/settings"
import type { LinkedBankAccount, MaintenanceRequest, Notice, TenantSummary } from "../types/tenant"
import { tenantConfirmation } from "../utils/confirmations"
import { tenantIdOf } from "../utils/user-id"
import { buildLedger, dueDates, formatDate, localDate } from "./ledger"

/**
 * What the tenant pages read and write, always for the signed-in tenant
 * (row-level security enforces the same in the database).
 */

const STATUS_FOR_UI: Record<string, MaintenanceRequest["status"]> = {
    submitted: "open",   // the tenant pages say "open"
    in_progress: "in_progress",
    resolved: "resolved",
}

export class TenantService {
    constructor(
        private readonly db: TenantStore,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}


    private today(): string {
        return localDate(new Date(), this.timeZone)
    }

    private currentLease(tID: number) {
        return this.db.findCurrentLease(tID, this.today())
    }

    async summary(userId: string, flags: { plaidEnabled: boolean; testPayments: boolean }): Promise<TenantSummary> {
        const tID = tenantIdOf(userId)
        const person = await this.db.findPerson(tID)
        if (!person) throw new AppError("NOT_FOUND")
        const name = person.name
        const lease = await this.currentLease(tID)
        const now = new Date()

        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("")
        const tenant = {
            id: userId,
            name,
            initials: initials || "?",
            unitLabel: lease ? `Unit ${lease.unitNum} - ${lease.propertyName}` : "No active lease",
            address: lease?.address ?? "",
        }

        let ledger: TenantSummary["ledger"] = []
        let balance = 0
        if (lease) {
            const built = await this.ledgerFor(lease.id)
            ledger = built.entries
            balance = built.balance
        }

        const [maintenanceRequests, bankAccounts, office, notificationPrefs, reported] = await Promise.all([
            this.maintenance(tID),
            this.bankAccounts(tID),
            this.db.getOfficeSettings(),
            this.db.getNotificationPrefs(tID),
            lease ? this.db.listReportedPayments({ leaseId: lease.id }) : Promise.resolve([]),
        ])
        const { rentDueDate, lateFeeGraceDate } = dueDates(balance, now)
        // Waiting ones, and decisions from the last 30 days.
        const recent = Date.now() - 30 * 86_400_000
        const reportedPayments: TenantReportedPayment[] = reported
            .filter((r) => r.status === "pending" || (r.reviewedAt && r.reviewedAt.getTime() > recent))
            .slice(0, 5)
            .map((r) => ({
                id: r.id,
                method: r.method,
                amount: r.amount,
                reportedOn: formatDate(r.reportedAt, this.timeZone),
                status: r.status === "pending" ? "pending" : r.decision === "rejected" ? "rejected" : "confirmed",
                reason: r.decision === "rejected" ? r.reason : null,
            }))

        return {
            tenant,
            contact: { email: person.email, phone: person.phone },
            payOptions: { cashapp: office.cashappHandle, zelle: office.zelleHandle },
            reportedPayments,
            notificationPrefs,
            currentBalance: balance,
            rentDueDate,
            lateFeeGraceDate,
            ledger,
            maintenanceRequests,
            notices: this.notices(ledger, maintenanceRequests, balance, rentDueDate, lateFeeGraceDate),
            bankAccounts,
            ...flags,
        }
    }

    private async ledgerFor(leaseId: number) {
        const [charges, payments] = await Promise.all([this.db.listChargesForLease(leaseId), this.db.listPaymentsForLease(leaseId)])
        return buildLedger(charges, payments, this.timeZone)
    }

    /**
     * One payment at a time: while a Cash App / Zelle report waits for the
     * office, the tenant can't report another or pay by bank (it would pay twice).
     */
    private async requireNoReportWaiting(leaseId: number): Promise<void> {
        const waiting = await this.db.listReportedPayments({ leaseId, pendingOnly: true })
        if (waiting.length) throw new AppError("ALREADY_REPORTED", { method: waiting[0]!.method, amount: waiting[0]!.amount })
    }

    /** Tenants pay the whole balance, never part of it (Summit, Oct 21). Returns the balance. */
    private async requireFullBalance(leaseId: number, amount: number): Promise<number> {
        const { balance } = await this.ledgerFor(leaseId)
        if (balance <= 0) throw new AppError("NOTHING_DUE")
        if (Math.abs(Math.round(amount * 100) - Math.round(balance * 100)) > 0) throw new AppError("AMOUNT_MUST_EQUAL_BALANCE", { balance })
        return balance
    }

    private async maintenance(tID: number): Promise<MaintenanceRequest[]> {
        const rows = await this.db.listTenantMaintenance(tID)
        return rows.map((row) => ({
            id: `mr_${row.id}`,
            title: row.title,
            description: row.description,
            submittedDate: formatDate(row.createdAt, this.timeZone),
            status: STATUS_FOR_UI[row.status] ?? "open",
        }))
    }

    createMaintenance(userId: string, input: { title: string; description: string }): Promise<MaintenanceRequest> {
        return this.log.flow("maintenance.create", { userId }, () => this.fileMaintenance(userId, input), (request) => ({ requestId: request.id }))
    }

    private async fileMaintenance(userId: string, input: { title: string; description: string }): Promise<MaintenanceRequest> {
        const tID = tenantIdOf(userId)
        const lease = await this.currentLease(tID)
        if (!lease) throw new AppError("NO_ACTIVE_LEASE")
        const created = await this.db.createMaintenance({ unitId: lease.unitId, tenantId: tID, title: input.title, description: input.description })
        return {
            id: `mr_${created.id}`,
            title: input.title,
            description: input.description,
            submittedDate: formatDate(created.createdAt, this.timeZone),
            status: "open",
        }
    }

    async bankAccounts(tID: number): Promise<LinkedBankAccount[]> {
        const rows = await this.db.listBankAccounts(tID)
        return rows.map((row) => ({ id: String(row.id), name: row.name, mask: row.mask, subtype: row.subtype }))
    }

    // logs plaid.accounts_saved: which plaid item, how many accounts came with it and how many the tenant now has
    saveBankAccounts(userId: string, item: BankItem, accounts: BankAccountInput[]): Promise<LinkedBankAccount[]> {
        return this.log.flow("plaid.accounts_saved", { userId, itemId: item.itemId, linked: accounts.length }, async () => {
            const tID = tenantIdOf(userId)
            await this.db.saveBankAccounts(tID, item, accounts)
            return this.bankAccounts(tID)
        }, (saved) => ({ total: saved.length }))
    }

    /**
     * Record a payment on the tenant's current lease, from a linked bank account.
     * No money moves yet: the transfer itself (Plaid Transfer or a processor) is still to come.
     */
    // logs payment.tenant.succeeded { userId, amount, method, leaseId, confirmation } or payment.tenant.failed { code }
    recordPayment(
        userId: string,
        input: { amount: number; bankAccountId: number | null; idempotencyKey?: string | null },
        flags: { plaidEnabled: boolean; testPayments: boolean },
    ): Promise<{ confirmation: string }> {
        const facts: { leaseId?: number } = {}
        return this.log.flow("payment.tenant", { userId, amount: input.amount, method: input.bankAccountId === null ? "test transfer" : "bank account" },
            () => this.pay(userId, input, flags, facts), (result) => ({ ...facts, confirmation: result.confirmation }))
    }

    private async pay(
        userId: string,
        input: { amount: number; bankAccountId: number | null; idempotencyKey?: string | null },
        flags: { plaidEnabled: boolean; testPayments: boolean },
        facts: { leaseId?: number },
    ): Promise<{ confirmation: string }> {
        // Without a linked account, only development records a test transfer.
        if (input.bankAccountId === null && !flags.testPayments) {
            throw new AppError(flags.plaidEnabled ? "VALIDATION_ERROR" : "PLAID_NOT_CONFIGURED")
        }
        const tID = tenantIdOf(userId)
        const lease = await this.currentLease(tID)
        if (!lease) throw new AppError("NO_ACTIVE_LEASE")
        facts.leaseId = lease.id
        // The same checkout again (double click, retry): the first payment's confirmation.
        const key = input.idempotencyKey ? `tenant:${tID}:${input.idempotencyKey}` : null
        const earlier = key ? await this.db.findConfirmationByKey(lease.id, key) : null
        if (earlier) return { confirmation: earlier }
        await this.requireFullBalance(lease.id, input.amount)
        await this.requireNoReportWaiting(lease.id)

        let method = "Test transfer (no bank linked)"
        if (input.bankAccountId !== null) {
            const account = await this.db.findBankAccount(tID, input.bankAccountId)
            if (!account) throw new AppError("NOT_FOUND")
            method = `${account.name}${account.mask ? ` ${account.mask}` : ""}`
        }

        return this.db.recordPayment({
            leaseId: lease.id,
            amount: input.amount,
            tenantId: tID,
            method: method.slice(0, 60),
            confirmation: tenantConfirmation(),
            // Scoped to the tenant, so one tenant's key can never match another's payment.
            idempotencyKey: key,
        })
    }

    /**
     * Cash App / Zelle: the tenant sent the full balance in their own app and
     * says so. Recorded as pending; it counts once the office confirms it.
     */
    // logs payment.tenant_reported.succeeded { userId, method, amount, leaseId } or .failed { code }
    reportPayment(userId: string, input: { method: ManualPayMethod; amount: number; idempotencyKey?: string | null }): Promise<{ confirmation: string }> {
        const facts: { leaseId?: number } = {}
        return this.log.flow("payment.tenant_reported", { userId, method: input.method, amount: input.amount }, async () => {
            const tID = tenantIdOf(userId)
            const lease = await this.currentLease(tID)
            if (!lease) throw new AppError("NO_ACTIVE_LEASE")
            facts.leaseId = lease.id
            const office = await this.db.getOfficeSettings()
            if (!(input.method === "cashapp" ? office.cashappHandle : office.zelleHandle)) throw new AppError("METHOD_NOT_AVAILABLE")
            const key = input.idempotencyKey ? `tenant:${tID}:${input.idempotencyKey}` : null
            const earlier = key ? await this.db.findConfirmationByKey(lease.id, key) : null
            if (earlier) return { confirmation: earlier }
            await this.requireFullBalance(lease.id, input.amount)
            await this.requireNoReportWaiting(lease.id)
            return this.db.recordPayment({
                leaseId: lease.id,
                amount: input.amount,
                tenantId: tID,
                method: `${MANUAL_PAY_LABELS[input.method]} (reported by tenant)`,
                confirmation: tenantConfirmation(),
                idempotencyKey: key,
                reported: { method: input.method },
            })
        }, () => facts)
    }

    // logs tenant.profile.update.succeeded { userId }
    updateProfile(userId: string, input: { name: string; phone: string | null }): Promise<void> {
        return this.log.flow("tenant.profile.update", { userId }, () => this.db.updateOwnProfile(input))
    }

    // logs tenant.notifications.update.succeeded { userId, ...choices }
    saveNotificationPrefs(userId: string, prefs: NotificationPrefs): Promise<void> {
        return this.log.flow("tenant.notifications.update", { userId, ...prefs }, () => this.db.saveNotificationPrefs(tenantIdOf(userId), prefs))
    }

    /** Notices built from what is on record (there is no notices table): rent due, payments, repair updates. */
    private notices(
        ledger: TenantSummary["ledger"],
        requests: MaintenanceRequest[],
        balance: number,
        rentDueDate: string,
        lateFeeGraceDate: string,
    ): Notice[] {
        const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" })
        const out: Array<Notice & { sortKey: number }> = []

        if (balance > 0) {
            out.push({
                id: "n_due",
                type: "due",
                title: `Rent due ${rentDueDate}`,
                body: `Your balance of ${money(balance)} is due ${rentDueDate}. A late fee may apply after ${lateFeeGraceDate}.`,
                nextStep: "Pay from the Pay rent page to avoid a late fee.",
                timestamp: formatDate(new Date(), this.timeZone),
                sortKey: Number.MAX_SAFE_INTEGER,
            })
        }
        for (const entry of ledger.filter((e) => e.amount > 0).slice(0, 5)) {
            out.push({
                id: `n_${entry.id}`,
                type: "payment",
                title: "Payment received",
                body: `Your payment of ${money(entry.amount)} was recorded on your account.`,
                nextStep: "No action needed - your receipt is in the ledger.",
                timestamp: entry.date,
                sortKey: Date.parse(entry.date),
            })
        }
        for (const request of requests.filter((r) => r.status !== "open").slice(0, 5)) {
            out.push({
                id: `n_${request.id}`,
                type: "maintenance",
                title: `Repair update: ${request.title}`,
                body: request.status === "resolved" ? "This request has been marked resolved." : "Work on this request is in progress.",
                nextStep: request.status === "resolved" ? "If the problem is back, file a new request." : "No action needed - we'll update you when it's resolved.",
                timestamp: request.submittedDate,
                sortKey: Date.parse(request.submittedDate),
            })
        }
        return out.sort((a, b) => b.sortKey - a.sortKey).map(({ sortKey: _sortKey, ...notice }) => notice)
    }
}
