import crypto from "crypto"
import type { Pool, PoolClient } from "pg"
import { AppError } from "../types/errors"
import type { DashboardData, LeaseDetail, MaintenanceRow, PropertySummary, TenantRow, UnitRow, UpdateRow } from "../types/manager"
import { buildLedger, formatDate } from "./ledger"
import type { DatabaseInterface } from "../types/interfaces"

/**
 * The manager side, on Angel's tables. Ported from the resident-portal
 * reference (manager dashboard, properties, units, tenants, lease page,
 * maintenance, updates), cut down to what the team's schema holds.
 *
 * Every property manager sees every property (client, 9/28), so nothing here
 * is filtered by assignment.
 */

interface LeaseRow {
    leaseid: number
    uid: number
    start_date: string
    end_date: string | null
    ammount_owed: string
}

interface PaymentRow {
    payid: number
    leaseid: number
    ammount: string
    paid_at: Date
    method: string | null
    confirmation: string | null
}

/** A receipt file, already checked by the route (type matches its first bytes, at most 4 MB). */
export interface Receipt {
    filename: string
    contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
    data: Buffer
}

const isActive = (lease: { start_date: string; end_date: string | null }, today: string) =>
    lease.start_date <= today && (lease.end_date === null || lease.end_date >= today)

export class ManagerStore {
    constructor(
        private readonly pool: Pool,
        private readonly auth: DatabaseInterface,
        private readonly options: { timeZone: string; now?: () => Date } = { timeZone: "America/Denver" },
    ) {}

    private now(): Date {
        return this.options.now?.() ?? new Date()
    }

    private today(): string {
        return this.now().toISOString().slice(0, 10)
    }

    /* ---------------------------------------------------------------- *
     * Balances: one pass over leases and payments, used by every screen
     * ---------------------------------------------------------------- */

    private async activeLeases(): Promise<Map<number, { lease: LeaseRow; balance: number; ledger: ReturnType<typeof buildLedger>["entries"] }>> {
        const today = this.today()
        const leases = (await this.pool.query<LeaseRow>(
            "SELECT LeaseID AS leaseid, uID AS uid, start_date::text AS start_date, end_date::text AS end_date, ammount_owed::text AS ammount_owed FROM Lease",
        )).rows.filter((l) => isActive(l, today))
        const payments = (await this.pool.query<PaymentRow>(
            "SELECT payID AS payid, LeaseID AS leaseid, ammount::text AS ammount, timestamp AS paid_at, method, confirmation FROM Payment ORDER BY timestamp",
        )).rows
        const byLease = new Map<number, PaymentRow[]>()
        for (const p of payments) byLease.set(p.leaseid, [...(byLease.get(p.leaseid) ?? []), p])

        const out = new Map<number, { lease: LeaseRow; balance: number; ledger: ReturnType<typeof buildLedger>["entries"] }>()
        for (const lease of leases) {
            const built = this.ledgerFor(lease, byLease.get(lease.leaseid) ?? [])
            out.set(lease.leaseid, { lease, balance: built.balance, ledger: built.entries })
        }
        return out
    }

    private ledgerFor(lease: LeaseRow, payments: PaymentRow[]) {
        return buildLedger(
            { startDate: lease.start_date, endDate: lease.end_date, monthlyRent: Number(lease.ammount_owed) },
            payments.map((p) => ({ id: p.payid, amount: Number(p.ammount), paidAt: p.paid_at, method: p.method, confirmation: p.confirmation })),
            this.now(),
            this.options.timeZone,
        )
    }

    private async leaseTenants(): Promise<Map<number, Array<{ id: number; name: string }>>> {
        const rows = (await this.pool.query<{ leaseid: number; tid: number; name: string }>(
            "SELECT lt.LeaseID AS leaseid, t.tID AS tid, t.Name AS name FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID ORDER BY t.Name",
        )).rows
        const out = new Map<number, Array<{ id: number; name: string }>>()
        for (const r of rows) out.set(r.leaseid, [...(out.get(r.leaseid) ?? []), { id: r.tid, name: r.name }])
        return out
    }

    /* ---------------------------------------------------------------- *
     * Units (the rent roll) and properties
     * ---------------------------------------------------------------- */

    async units(propertyId?: number): Promise<UnitRow[]> {
        const [active, people, units, open] = await Promise.all([
            this.activeLeases(),
            this.leaseTenants(),
            this.pool.query<{ uid: number; pid: number; unitnum: string; property_name: string }>(
                `SELECT u.uID AS uid, u.pID AS pid, u.UnitNum AS unitnum, p.Name AS property_name
                 FROM Units u JOIN Property p ON p.pID = u.pID
                 WHERE ($1::int IS NULL OR u.pID = $1)
                 ORDER BY p.Name, u.UnitNum`,
                [propertyId ?? null],
            ),
            this.pool.query<{ uid: number; n: number }>(
                "SELECT uID AS uid, count(*)::int AS n FROM Maintenance_T WHERE status <> 'resolved' GROUP BY uID",
            ),
        ])
        const leaseByUnit = new Map<number, { lease: LeaseRow; balance: number }>()
        for (const entry of active.values()) {
            const existing = leaseByUnit.get(entry.lease.uid)
            if (!existing || existing.lease.start_date < entry.lease.start_date) leaseByUnit.set(entry.lease.uid, entry)
        }
        const openByUnit = new Map(open.rows.map((r) => [r.uid, r.n]))

        return units.rows.map((u) => {
            const current = leaseByUnit.get(u.uid)
            const balance = current?.balance ?? 0
            return {
                id: u.uid,
                propertyId: u.pid,
                propertyName: u.property_name,
                unitNum: u.unitnum,
                leaseId: current?.lease.leaseid ?? null,
                tenants: current ? people.get(current.lease.leaseid) ?? [] : [],
                monthlyRent: current ? Number(current.lease.ammount_owed) : null,
                balance,
                startDate: current?.lease.start_date ?? null,
                endDate: current?.lease.end_date ?? null,
                status: !current ? "vacant" : balance > 0 ? "owing" : "current",
                openRequests: openByUnit.get(u.uid) ?? 0,
            }
        })
    }

    async properties(): Promise<PropertySummary[]> {
        const [props, units] = await Promise.all([
            this.pool.query<{ pid: number; name: string; address: string }>("SELECT pID AS pid, Name AS name, Address AS address FROM Property ORDER BY Name"),
            this.units(),
        ])
        return props.rows.map((p) => {
            const mine = units.filter((u) => u.propertyId === p.pid)
            return {
                id: p.pid,
                name: p.name,
                address: p.address,
                units: mine.length,
                occupied: mine.filter((u) => u.status !== "vacant").length,
                monthlyRent: mine.reduce((sum, u) => sum + (u.monthlyRent ?? 0), 0),
                outstanding: mine.reduce((sum, u) => sum + Math.max(0, u.balance), 0),
            }
        })
    }

    async saveProperty(id: number | null, input: { name: string; address: string }): Promise<number> {
        if (id === null) {
            const { rows } = await this.pool.query<{ pid: number }>("INSERT INTO Property (Name, Address) VALUES ($1, $2) RETURNING pID AS pid", [input.name, input.address])
            return rows[0]!.pid
        }
        const result = await this.pool.query("UPDATE Property SET Name = $2, Address = $3 WHERE pID = $1", [id, input.name, input.address])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
        return id
    }

    async saveUnit(id: number | null, input: { propertyId: number; unitNum: string }): Promise<number> {
        const property = await this.pool.query("SELECT 1 FROM Property WHERE pID = $1", [input.propertyId])
        if (!property.rowCount) throw new AppError("NOT_FOUND")
        const duplicate = await this.pool.query(
            "SELECT 1 FROM Units WHERE pID = $1 AND lower(UnitNum) = lower($2) AND ($3::int IS NULL OR uID <> $3)",
            [input.propertyId, input.unitNum, id],
        )
        if (duplicate.rowCount) throw new AppError("VALIDATION_ERROR")
        if (id === null) {
            const { rows } = await this.pool.query<{ uid: number }>("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS uid", [input.propertyId, input.unitNum])
            return rows[0]!.uid
        }
        const result = await this.pool.query("UPDATE Units SET pID = $2, UnitNum = $3 WHERE uID = $1", [id, input.propertyId, input.unitNum])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
        return id
    }

    /* ---------------------------------------------------------------- *
     * Tenants
     * ---------------------------------------------------------------- */

    async tenants(): Promise<TenantRow[]> {
        const [people, active, links, units] = await Promise.all([
            this.pool.query<{ tid: number; name: string; email: string; phone: string | null; signed_up: boolean }>(
                "SELECT tID AS tid, Name AS name, Email AS email, Phone AS phone, signed_up FROM Tenants ORDER BY Name",
            ),
            this.activeLeases(),
            this.pool.query<{ leaseid: number; tid: number }>("SELECT LeaseID AS leaseid, tID AS tid FROM Lease_Tenants"),
            this.pool.query<{ uid: number; label: string }>(
                "SELECT u.uID AS uid, 'Unit ' || u.UnitNum || ' - ' || p.Name AS label FROM Units u JOIN Property p ON p.pID = u.pID",
            ),
        ])
        const unitLabel = new Map(units.rows.map((u) => [u.uid, u.label]))
        return people.rows.map((t) => {
            const lease = links.rows.map((l) => (l.tid === t.tid ? active.get(l.leaseid) : undefined)).find(Boolean)
            return {
                id: t.tid,
                name: t.name,
                email: t.email,
                phone: t.phone,
                signedUp: t.signed_up,
                leaseId: lease?.lease.leaseid ?? null,
                unitLabel: lease ? unitLabel.get(lease.lease.uid) ?? null : null,
                balance: lease?.balance ?? 0,
            }
        })
    }

    /** Add a tenant the way the team agreed (10/1): the office adds them, they sign up later. */
    async inviteTenant(input: { name: string; email: string; phone: string | null }): Promise<number> {
        try {
            const invited = await this.auth.inviteTenant(input)
            return Number(invited.id.split(":")[1])
        } catch (error) {
            if ((error as { code?: string }).code === "23505") throw new AppError("EMAIL_IN_USE")
            throw error
        }
    }

    async updateTenant(tID: number, input: { name: string; phone: string | null }): Promise<void> {
        const result = await this.pool.query("UPDATE Tenants SET Name = $2, Phone = $3 WHERE tID = $1", [tID, input.name, input.phone])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /* ---------------------------------------------------------------- *
     * Leases
     * ---------------------------------------------------------------- */

    async lease(leaseId: number): Promise<LeaseDetail> {
        const { rows } = await this.pool.query<LeaseRow & { unitnum: string; pid: number; property_name: string; address: string }>(
            `SELECT l.LeaseID AS leaseid, l.uID AS uid, l.start_date::text AS start_date, l.end_date::text AS end_date,
                    l.ammount_owed::text AS ammount_owed, u.UnitNum AS unitnum, p.pID AS pid, p.Name AS property_name, p.Address AS address
             FROM Lease l JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID WHERE l.LeaseID = $1`,
            [leaseId],
        )
        const lease = rows[0]
        if (!lease) throw new AppError("NOT_FOUND")
        const [payments, people, receipts] = await Promise.all([
            this.pool.query<PaymentRow>(
                "SELECT payID AS payid, LeaseID AS leaseid, ammount::text AS ammount, timestamp AS paid_at, method, confirmation FROM Payment WHERE LeaseID = $1 ORDER BY timestamp",
                [leaseId],
            ),
            this.pool.query<{ tid: number; name: string; email: string; phone: string | null; signed_up: boolean }>(
                `SELECT t.tID AS tid, t.Name AS name, t.Email AS email, t.Phone AS phone, t.signed_up
                 FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID WHERE lt.LeaseID = $1 ORDER BY t.Name`,
                [leaseId],
            ),
            this.pool.query<{ payid: number }>(
                "SELECT r.payID AS payid FROM Payment_Receipts r JOIN Payment p ON p.payID = r.payID WHERE p.LeaseID = $1",
                [leaseId],
            ),
        ])
        const built = this.ledgerFor(lease, payments.rows)
        return {
            id: lease.leaseid,
            unitId: lease.uid,
            unitNum: lease.unitnum,
            propertyId: lease.pid,
            propertyName: lease.property_name,
            address: lease.address,
            startDate: lease.start_date,
            endDate: lease.end_date,
            monthlyRent: Number(lease.ammount_owed),
            tenants: people.rows.map((t) => ({ id: t.tid, name: t.name, email: t.email, phone: t.phone, signedUp: t.signed_up })),
            balance: built.balance,
            ledger: built.entries,
            receiptPaymentIds: receipts.rows.map((r) => r.payid),
        }
    }

    /**
     * Start a lease on a vacant unit, with existing tenants and/or new ones
     * (who are added as invited and sign up themselves).
     */
    async createLease(input: {
        unitId: number
        startDate: string
        endDate: string | null
        monthlyRent: number
        tenantIds: number[]
        newTenants: Array<{ name: string; email: string; phone: string | null }>
    }): Promise<number> {
        if (input.tenantIds.length + input.newTenants.length === 0) throw new AppError("VALIDATION_ERROR")
        if (input.endDate && input.endDate < input.startDate) throw new AppError("VALIDATION_ERROR")
        const unit = (await this.units()).find((u) => u.id === input.unitId)
        if (!unit) throw new AppError("NOT_FOUND")
        if (unit.status !== "vacant") throw new AppError("UNIT_OCCUPIED")

        const client = await this.pool.connect()
        try {
            await client.query("BEGIN")
            const ids = [...input.tenantIds]
            for (const person of input.newTenants) ids.push(await this.inviteInTx(client, person))
            const { rows } = await client.query<{ leaseid: number }>(
                "INSERT INTO Lease (uID, start_date, end_date, ammount_owed) VALUES ($1, $2, $3, $4) RETURNING LeaseID AS leaseid",
                [input.unitId, input.startDate, input.endDate, input.monthlyRent.toFixed(2)],
            )
            const leaseId = rows[0]!.leaseid
            for (const tID of new Set(ids)) {
                const exists = await client.query("SELECT 1 FROM Tenants WHERE tID = $1", [tID])
                if (!exists.rowCount) throw new AppError("NOT_FOUND")
                await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [leaseId, tID])
            }
            await client.query("COMMIT")
            return leaseId
        } catch (error) {
            await client.query("ROLLBACK")
            if ((error as { code?: string }).code === "23505") throw new AppError("EMAIL_IN_USE")
            throw error
        } finally {
            client.release()
        }
    }

    private async inviteInTx(client: PoolClient, person: { name: string; email: string; phone: string | null }): Promise<number> {
        const { rows } = await client.query<{ tid: number }>(
            "INSERT INTO Tenants (Name, Phone, Email) VALUES ($1, $2, $3) RETURNING tID AS tid",
            [person.name, person.phone, person.email.trim().toLowerCase()],
        )
        return rows[0]!.tid
    }

    async updateLease(leaseId: number, input: { monthlyRent?: number; endDate?: string | null }): Promise<void> {
        const current = await this.pool.query<{ start_date: string }>("SELECT start_date::text AS start_date FROM Lease WHERE LeaseID = $1", [leaseId])
        if (!current.rows[0]) throw new AppError("NOT_FOUND")
        if (input.endDate && input.endDate < current.rows[0].start_date) throw new AppError("VALIDATION_ERROR")
        if (input.monthlyRent !== undefined) {
            await this.pool.query("UPDATE Lease SET ammount_owed = $2 WHERE LeaseID = $1", [leaseId, input.monthlyRent.toFixed(2)])
        }
        if (input.endDate !== undefined) {
            await this.pool.query("UPDATE Lease SET end_date = $2 WHERE LeaseID = $1", [leaseId, input.endDate])
        }
    }

    async addTenantToLease(leaseId: number, input: { tenantId?: number; newTenant?: { name: string; email: string; phone: string | null } }): Promise<void> {
        const lease = await this.pool.query("SELECT 1 FROM Lease WHERE LeaseID = $1", [leaseId])
        if (!lease.rowCount) throw new AppError("NOT_FOUND")
        let tID = input.tenantId
        if (input.newTenant) tID = await this.inviteTenant(input.newTenant)
        if (!tID) throw new AppError("VALIDATION_ERROR")
        await this.pool.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2) ON CONFLICT DO NOTHING", [leaseId, tID])
    }

    async removeTenantFromLease(leaseId: number, tID: number): Promise<void> {
        const count = await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM Lease_Tenants WHERE LeaseID = $1", [leaseId])
        if ((count.rows[0]?.n ?? 0) <= 1) throw new AppError("VALIDATION_ERROR") // a lease keeps at least one tenant
        const result = await this.pool.query("DELETE FROM Lease_Tenants WHERE LeaseID = $1 AND tID = $2", [leaseId, tID])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /** An offline payment the office received (check, cash, money order…). */
    async recordPayment(
        leaseId: number,
        input: { amount: number; method: string; tenantId: number | null; receipt?: Receipt | null },
    ): Promise<string> {
        const lease = await this.pool.query("SELECT 1 FROM Lease WHERE LeaseID = $1", [leaseId])
        if (!lease.rowCount) throw new AppError("NOT_FOUND")
        if (input.tenantId !== null) {
            const onLease = await this.pool.query("SELECT 1 FROM Lease_Tenants WHERE LeaseID = $1 AND tID = $2", [leaseId, input.tenantId])
            if (!onLease.rowCount) throw new AppError("VALIDATION_ERROR")
        }
        const confirmation = `OFF-${crypto.randomInt(10_000_000, 99_999_999)}`
        // The payment and its receipt are saved together or not at all.
        const client = await this.pool.connect()
        try {
            await client.query("BEGIN")
            const { rows } = await client.query<{ payid: number }>(
                "INSERT INTO Payment (LeaseID, ammount, tID, method, confirmation) VALUES ($1, $2, $3, $4, $5) RETURNING payID AS payid",
                [leaseId, input.amount.toFixed(2), input.tenantId, `${input.method} (recorded by office)`.slice(0, 60), confirmation],
            )
            if (input.receipt) await this.saveReceipt(client, rows[0]!.payid, input.receipt)
            await client.query("COMMIT")
        } catch (error) {
            await client.query("ROLLBACK")
            throw error
        } finally {
            client.release()
        }
        return confirmation
    }

    /* ---------------------------------------------------------------- *
     * Receipts (004): stored in the database next to the payment
     * ---------------------------------------------------------------- */

    private async saveReceipt(client: PoolClient | Pool, payId: number, receipt: Receipt): Promise<void> {
        await client.query(
            `INSERT INTO Payment_Receipts (payID, filename, content_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (payID) DO UPDATE SET filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
               size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, uploaded_at = now()`,
            [payId, receipt.filename, receipt.contentType, receipt.data.length, receipt.data],
        )
    }

    /** Attach (or replace) the receipt of a payment already on the lease. */
    async attachReceipt(leaseId: number, payId: number, receipt: Receipt): Promise<void> {
        const payment = await this.pool.query("SELECT 1 FROM Payment WHERE payID = $1 AND LeaseID = $2", [payId, leaseId])
        if (!payment.rowCount) throw new AppError("NOT_FOUND")
        await this.saveReceipt(this.pool, payId, receipt)
    }

    async receipt(leaseId: number, payId: number): Promise<Receipt> {
        const { rows } = await this.pool.query<{ filename: string; content_type: Receipt["contentType"]; data: Buffer }>(
            `SELECT r.filename, r.content_type, r.data FROM Payment_Receipts r JOIN Payment p ON p.payID = r.payID
             WHERE r.payID = $1 AND p.LeaseID = $2`,
            [payId, leaseId],
        )
        if (!rows[0]) throw new AppError("NOT_FOUND")
        return { filename: rows[0].filename, contentType: rows[0].content_type, data: rows[0].data }
    }

    async maintenance(): Promise<MaintenanceRow[]> {
        const { rows } = await this.pool.query<{
            mid: number; title: string; description: string; status: MaintenanceRow["status"]; created_at: Date
            uid: number; unitnum: string; property_name: string; tenant_name: string | null
        }>(
            `SELECT m.mID AS mid, m.title, m.description, m.status, m.created_at, u.uID AS uid, u.UnitNum AS unitnum,
                    p.Name AS property_name, t.Name AS tenant_name
             FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID
             LEFT JOIN Tenants t ON t.tID = m.tID
             ORDER BY (m.status = 'resolved'), m.created_at DESC`,
        )
        return rows.map((r) => ({
            id: r.mid,
            title: r.title,
            description: r.description,
            status: r.status,
            submittedDate: formatDate(r.created_at, this.options.timeZone),
            unitId: r.uid,
            unitNum: r.unitnum,
            propertyName: r.property_name,
            tenantName: r.tenant_name,
        }))
    }

    async createMaintenance(input: { unitId: number; title: string; description: string }): Promise<number> {
        const unit = await this.pool.query("SELECT 1 FROM Units WHERE uID = $1", [input.unitId])
        if (!unit.rowCount) throw new AppError("NOT_FOUND")
        const { rows } = await this.pool.query<{ mid: number }>(
            "INSERT INTO Maintenance_T (uID, title, description) VALUES ($1, $2, $3) RETURNING mID AS mid",
            [input.unitId, input.title, input.description],
        )
        return rows[0]!.mid
    }

    async setMaintenanceStatus(id: number, status: MaintenanceRow["status"]): Promise<void> {
        const result = await this.pool.query("UPDATE Maintenance_T SET status = $2 WHERE mID = $1", [id, status])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /* ---------------------------------------------------------------- *
     * Deleting: only what leaves the records honest. Anything with money
     * history (a lease with payments, a unit or property that was ever
     * leased) stays on record; the database's own RESTRICT rules back this up.
     * ---------------------------------------------------------------- */

    /** A tenant who is not on a current lease. Their past payments and requests stay, unattributed. */
    async deleteTenant(tID: number): Promise<void> {
        const tenant = await this.pool.query("SELECT 1 FROM Tenants WHERE tID = $1", [tID])
        if (!tenant.rowCount) throw new AppError("NOT_FOUND")
        // Current or future leases count; only leases that have ended let go of them.
        const onLease = await this.pool.query(
            `SELECT 1 FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID
             WHERE lt.tID = $1 AND (l.end_date IS NULL OR l.end_date >= $2::date) LIMIT 1`,
            [tID, this.today()],
        )
        if (onLease.rowCount) throw new AppError("TENANT_ON_LEASE")
        await this.pool.query("DELETE FROM Tenants WHERE tID = $1", [tID])
    }

    /** A lease entered by mistake: no payments yet. Its residents stay, as invited tenants. */
    async deleteLease(leaseId: number): Promise<void> {
        const client = await this.pool.connect()
        try {
            await client.query("BEGIN")
            const lease = await client.query("SELECT 1 FROM Lease WHERE LeaseID = $1 FOR UPDATE", [leaseId])
            if (!lease.rowCount) throw new AppError("NOT_FOUND")
            const paid = await client.query("SELECT 1 FROM Payment WHERE LeaseID = $1 LIMIT 1", [leaseId])
            if (paid.rowCount) throw new AppError("LEASE_HAS_PAYMENTS")
            await client.query("DELETE FROM Lease WHERE LeaseID = $1", [leaseId])
            await client.query("COMMIT")
        } catch (error) {
            await client.query("ROLLBACK")
            throw error
        } finally {
            client.release()
        }
    }

    /** Undo a payment the office recorded (confirmation OFF-…). Tenant payments stay. */
    async deleteOfficePayment(leaseId: number, payId: number): Promise<void> {
        const removed = await this.pool.query(
            "DELETE FROM Payment WHERE payID = $1 AND LeaseID = $2 AND confirmation LIKE 'OFF-%'",
            [payId, leaseId],
        )
        if (removed.rowCount) return
        const exists = await this.pool.query("SELECT 1 FROM Payment WHERE payID = $1 AND LeaseID = $2", [payId, leaseId])
        throw new AppError(exists.rowCount ? "NOT_OFFICE_PAYMENT" : "NOT_FOUND")
    }

    /** A unit that was never leased. Its maintenance requests go with it. */
    async deleteUnit(uID: number): Promise<void> {
        const unit = await this.pool.query("SELECT 1 FROM Units WHERE uID = $1", [uID])
        if (!unit.rowCount) throw new AppError("NOT_FOUND")
        const leased = await this.pool.query("SELECT 1 FROM Lease WHERE uID = $1 LIMIT 1", [uID])
        if (leased.rowCount) throw new AppError("UNIT_HAS_LEASES")
        try {
            await this.pool.query("DELETE FROM Units WHERE uID = $1", [uID])
        } catch (error) {
            if ((error as { code?: string }).code === "23503") throw new AppError("UNIT_HAS_LEASES")
            throw error
        }
    }

    /** A property none of whose units was ever leased. Its units go with it. */
    async deleteProperty(pID: number): Promise<void> {
        const property = await this.pool.query("SELECT 1 FROM Property WHERE pID = $1", [pID])
        if (!property.rowCount) throw new AppError("NOT_FOUND")
        const leased = await this.pool.query("SELECT 1 FROM Lease l JOIN Units u ON u.uID = l.uID WHERE u.pID = $1 LIMIT 1", [pID])
        if (leased.rowCount) throw new AppError("PROPERTY_HAS_LEASES")
        try {
            await this.pool.query("DELETE FROM Property WHERE pID = $1", [pID])
        } catch (error) {
            if ((error as { code?: string }).code === "23503") throw new AppError("PROPERTY_HAS_LEASES")
            throw error
        }
    }

    /** A maintenance request filed by mistake or no longer needed. */
    async deleteMaintenance(mID: number): Promise<void> {
        const removed = await this.pool.query("DELETE FROM Maintenance_T WHERE mID = $1", [mID])
        if (!removed.rowCount) throw new AppError("NOT_FOUND")
    }

    /** The signed-in staff member's name for the sidebar ("admin:N" ids only). */
    async staffProfile(userId: string): Promise<{ name: string; email: string; role: string }> {
        const match = /^admin:([1-9][0-9]{0,9})$/.exec(userId)
        if (!match) throw new AppError("NOT_FOUND")
        const { rows } = await this.pool.query<{ name: string; email: string; role: string }>(
            "SELECT name, email, role FROM Admin WHERE admin_id = $1",
            [Number(match[1])],
        )
        if (!rows[0]) throw new AppError("NOT_FOUND")
        return rows[0]
    }

    /* ---------------------------------------------------------------- *
     * Dashboard and Updates
     * ---------------------------------------------------------------- */

    async updates(): Promise<UpdateRow[]> {
        const [units, maintenance, tenants] = await Promise.all([this.units(), this.maintenance(), this.tenants()])
        const out: UpdateRow[] = []
        for (const u of units.filter((x) => x.status === "owing")) {
            const months = u.monthlyRent ? u.balance / u.monthlyRent : 0
            out.push({
                kind: "overdue",
                title: months >= 1.5 ? "Past due more than a month" : "Rent outstanding",
                detail: `${u.tenants.map((t) => t.name).join(", ") || "No tenant"} owes ${u.balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}.`,
                leaseId: u.leaseId,
                unitLabel: `Unit ${u.unitNum} - ${u.propertyName}`,
                amount: u.balance,
                severity: months >= 1.5 ? 80 : 50,
            })
        }
        for (const m of maintenance.filter((x) => x.status === "submitted")) {
            out.push({
                kind: "maintenance_new",
                title: `New maintenance request: ${m.title}`,
                detail: `${m.tenantName ?? "Filed by the office"} · submitted ${m.submittedDate}`,
                leaseId: units.find((u) => u.id === m.unitId)?.leaseId ?? null,
                unitLabel: `Unit ${m.unitNum} - ${m.propertyName}`,
                amount: null,
                severity: 60,
            })
        }
        for (const t of tenants.filter((x) => !x.signedUp && x.leaseId !== null)) {
            out.push({
                kind: "not_signed_up",
                title: "Has not signed up yet",
                detail: `${t.name} (${t.email}) was added but has not created a password.`,
                leaseId: t.leaseId,
                unitLabel: t.unitLabel ?? "",
                amount: null,
                severity: 20,
            })
        }
        return out.sort((a, b) => b.severity - a.severity || (b.amount ?? 0) - (a.amount ?? 0))
    }

    async dashboard(): Promise<DashboardData> {
        const [units, properties, updates, maintenance, payments] = await Promise.all([
            this.units(),
            this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM Property"),
            this.updates(),
            this.maintenance(),
            this.pool.query<{ ammount: string; paid_at: Date; method: string | null; unitnum: string; payer: string | null }>(
                `SELECT p.ammount::text AS ammount, p.timestamp AS paid_at, p.method, u.UnitNum AS unitnum, t.Name AS payer
                 FROM Payment p JOIN Lease l ON l.LeaseID = p.LeaseID JOIN Units u ON u.uID = l.uID
                 LEFT JOIN Tenants t ON t.tID = p.tID
                 ORDER BY p.timestamp DESC LIMIT 200`,
            ),
        ])
        const now = this.now()
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        const occupied = units.filter((u) => u.status !== "vacant")
        const collectedThisMonth = payments.rows
            .filter((p) => p.paid_at >= monthStart)
            .reduce((sum, p) => sum + Number(p.ammount), 0)
        const activity = [
            ...payments.rows.slice(0, 8).map((p) => ({
                kind: "payment" as const,
                title: "Payment received",
                detail: `${p.payer ?? "Office"} · Unit ${p.unitnum} · ${Number(p.ammount).toLocaleString("en-US", { style: "currency", currency: "USD" })}`,
                when: formatDate(p.paid_at, this.options.timeZone),
                at: p.paid_at.toISOString(),
            })),
            ...maintenance.slice(0, 8).map((m) => ({
                kind: "maintenance" as const,
                title: m.status === "resolved" ? "Maintenance completed" : "Maintenance request",
                detail: `Unit ${m.unitNum} · ${m.title}`,
                when: m.submittedDate,
                at: new Date(Date.parse(m.submittedDate)).toISOString(),
            })),
        ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)

        return {
            properties: properties.rows[0]!.n,
            units: units.length,
            occupied: occupied.length,
            vacant: units.length - occupied.length,
            expectedThisMonth: occupied.reduce((sum, u) => sum + (u.monthlyRent ?? 0), 0),
            collectedThisMonth: Math.round(collectedThisMonth * 100) / 100,
            outstanding: Math.round(units.reduce((sum, u) => sum + Math.max(0, u.balance), 0) * 100) / 100,
            overdueAccounts: units.filter((u) => u.status === "owing").length,
            openMaintenance: maintenance.filter((m) => m.status !== "resolved").length,
            recentActivity: activity,
            updates: updates.slice(0, 6),
        }
    }
}
