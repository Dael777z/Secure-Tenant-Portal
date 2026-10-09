import crypto from "crypto"
import type { Pool } from "pg"
import { AppError } from "../types/errors"
import type { LinkedBankAccount, MaintenanceRequest, Notice, TenantSummary } from "../types/tenant"
import { buildLedger, dueDates, formatDate } from "./ledger"
import { parseUserId } from "./postgres-db"

/**
 * Everything the tenant pages read and write, on Angel's tables. Every query
 * starts from the signed-in tenant's own tID, so a tenant only ever reaches
 * their own lease, payments, requests and bank accounts.
 */

interface LeaseRow {
    leaseid: number
    uid: number
    start_date: string
    end_date: string | null
    ammount_owed: string
    unitnum: string
    property_name: string
    address: string
}

const STATUS_FOR_UI: Record<string, MaintenanceRequest["status"]> = {
    // Angel's value → Juan's value. The database keeps "submitted".
    submitted: "open",
    in_progress: "in_progress",
    resolved: "resolved",
}

export function tenantIdOf(userId: string): number {
    const owner = parseUserId(userId)
    if (!owner || owner.table !== "tenant") throw new AppError("NOT_FOUND")
    return owner.id
}

export class TenantStore {
    constructor(
        private readonly pool: Pool,
        private readonly options: { timeZone: string; now?: () => Date } = { timeZone: "America/Denver" },
    ) {}

    private now(): Date {
        return this.options.now?.() ?? new Date()
    }

    /** The tenant's current lease: started, not ended, newest first. */
    private async currentLease(tID: number): Promise<LeaseRow | null> {
        const { rows } = await this.pool.query<LeaseRow>(
            `SELECT l.LeaseID AS leaseid, l.uID AS uid, l.start_date::text AS start_date, l.end_date::text AS end_date,
                    l.ammount_owed::text AS ammount_owed, u.UnitNum AS unitnum, p.Name AS property_name, p.Address AS address
             FROM Lease_Tenants lt
             JOIN Lease l ON l.LeaseID = lt.LeaseID
             JOIN Units u ON u.uID = l.uID
             JOIN Property p ON p.pID = u.pID
             WHERE lt.tID = $1 AND l.start_date <= $2::date AND (l.end_date IS NULL OR l.end_date >= $2::date)
             ORDER BY l.start_date DESC, l.LeaseID DESC
             LIMIT 1`,
            [tID, this.now().toISOString().slice(0, 10)],
        )
        return rows[0] ?? null
    }

    async summary(userId: string, plaidEnabled: boolean): Promise<TenantSummary> {
        const tID = tenantIdOf(userId)
        const person = await this.pool.query<{ name: string }>("SELECT Name AS name FROM Tenants WHERE tID = $1", [tID])
        if (!person.rows[0]) throw new AppError("NOT_FOUND")
        const name = person.rows[0].name
        const lease = await this.currentLease(tID)
        const now = this.now()

        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("")
        const tenant = {
            id: userId,
            name,
            initials: initials || "?",
            unitLabel: lease ? `Unit ${lease.unitnum} - ${lease.property_name}` : "No active lease",
            address: lease?.address ?? "",
        }

        let ledger: TenantSummary["ledger"] = []
        let balance = 0
        if (lease) {
            const payments = await this.pool.query<{ payid: number; ammount: string; paid_at: Date; method: string | null; confirmation: string | null }>(
                `SELECT payID AS payid, ammount::text AS ammount, timestamp AS paid_at, method, confirmation
                 FROM Payment WHERE LeaseID = $1 ORDER BY timestamp`,
                [lease.leaseid],
            )
            const built = buildLedger(
                { startDate: lease.start_date, endDate: lease.end_date, monthlyRent: Number(lease.ammount_owed) },
                payments.rows.map((p) => ({
                    id: p.payid,
                    amount: Number(p.ammount),
                    paidAt: p.paid_at,
                    method: p.method,
                    confirmation: p.confirmation,
                })),
                now,
                this.options.timeZone,
            )
            ledger = built.entries
            balance = built.balance
        }

        const maintenanceRequests = await this.maintenance(tID)
        const bankAccounts = await this.bankAccounts(tID)
        const { rentDueDate, lateFeeGraceDate } = dueDates(balance, now)

        return {
            tenant,
            currentBalance: balance,
            rentDueDate,
            lateFeeGraceDate,
            ledger,
            maintenanceRequests,
            notices: this.notices(ledger, maintenanceRequests, balance, rentDueDate, lateFeeGraceDate),
            bankAccounts,
            plaidEnabled,
        }
    }

    private async maintenance(tID: number): Promise<MaintenanceRequest[]> {
        // The tenant's own requests, plus any filed for their unit by the office.
        const { rows } = await this.pool.query<{ mid: number; title: string; description: string; created_at: Date; status: string }>(
            `SELECT m.mID AS mid, m.title, m.description, m.created_at, m.status
             FROM Maintenance_T m
             WHERE m.tID = $1
                OR m.uID IN (SELECT l.uID FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID
                             WHERE lt.tID = $1 AND (l.end_date IS NULL OR l.end_date >= CURRENT_DATE))
             ORDER BY m.created_at DESC, m.mID DESC`,
            [tID],
        )
        return rows.map((row) => ({
            id: `mr_${row.mid}`,
            title: row.title,
            description: row.description,
            submittedDate: formatDate(row.created_at, this.options.timeZone),
            status: STATUS_FOR_UI[row.status] ?? "open",
        }))
    }

    async createMaintenance(userId: string, input: { title: string; description: string }): Promise<MaintenanceRequest> {
        const tID = tenantIdOf(userId)
        const lease = await this.currentLease(tID)
        if (!lease) throw new AppError("NO_ACTIVE_LEASE")
        const { rows } = await this.pool.query<{ mid: number; created_at: Date }>(
            `INSERT INTO Maintenance_T (uID, tID, title, description) VALUES ($1, $2, $3, $4)
             RETURNING mID AS mid, created_at`,
            [lease.uid, tID, input.title, input.description],
        )
        const row = rows[0]!
        return {
            id: `mr_${row.mid}`,
            title: input.title,
            description: input.description,
            submittedDate: formatDate(row.created_at, this.options.timeZone),
            status: "open",
        }
    }

    async bankAccounts(tID: number): Promise<LinkedBankAccount[]> {
        const { rows } = await this.pool.query<{ bid: number; name: string; mask: string | null; subtype: string | null }>(
            "SELECT bID AS bid, name, mask, subtype FROM Bank_Accounts WHERE tID = $1 ORDER BY created_at",
            [tID],
        )
        return rows.map((row) => ({ id: String(row.bid), name: row.name, mask: row.mask, subtype: row.subtype }))
    }

    async saveBankAccounts(
        userId: string,
        item: { itemId: string; accessTokenEnc: string },
        accounts: Array<{ accountId: string; name: string; mask: string | null; subtype: string | null }>,
    ): Promise<LinkedBankAccount[]> {
        const tID = tenantIdOf(userId)
        for (const account of accounts) {
            await this.pool.query(
                `INSERT INTO Bank_Accounts (tID, plaid_item_id, plaid_account_id, access_token_enc, name, mask, subtype)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (tID, plaid_account_id) DO UPDATE
                   SET plaid_item_id = EXCLUDED.plaid_item_id, access_token_enc = EXCLUDED.access_token_enc,
                       name = EXCLUDED.name, mask = EXCLUDED.mask, subtype = EXCLUDED.subtype`,
                [tID, item.itemId, account.accountId, item.accessTokenEnc, account.name, account.mask, account.subtype],
            )
        }
        return this.bankAccounts(tID)
    }

    /**
     * Record a payment on the tenant's current lease. No money moves yet: the
     * real transfer (Plaid Transfer or a processor) is the next payments step.
     */
    async recordPayment(userId: string, input: { amount: number; bankAccountId: string | null }): Promise<{ confirmation: string }> {
        const tID = tenantIdOf(userId)
        const lease = await this.currentLease(tID)
        if (!lease) throw new AppError("NO_ACTIVE_LEASE")

        let method = "Bank transfer (demo)"
        if (input.bankAccountId !== null) {
            const account = await this.pool.query<{ name: string; mask: string | null }>(
                "SELECT name, mask FROM Bank_Accounts WHERE bID = $1 AND tID = $2",
                [Number(input.bankAccountId), tID],
            )
            if (!account.rows[0]) throw new AppError("NOT_FOUND")
            method = `${account.rows[0].name}${account.rows[0].mask ? ` ${account.rows[0].mask}` : ""}`
        }

        const confirmation = `CONF-${crypto.randomInt(10_000_000, 99_999_999)}`
        await this.pool.query(
            "INSERT INTO Payment (LeaseID, ammount, tID, method, confirmation) VALUES ($1, $2, $3, $4, $5)",
            [lease.leaseid, input.amount.toFixed(2), tID, method.slice(0, 60), confirmation],
        )
        return { confirmation }
    }

    /**
     * Notices, made from what is already on record (there is no notices table):
     * payments received, repair updates, and rent due.
     */
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
                timestamp: formatDate(this.now(), this.options.timeZone),
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
