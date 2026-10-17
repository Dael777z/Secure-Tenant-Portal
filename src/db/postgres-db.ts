import { types, type Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg"

import type {
    BankAccountInput, BankItem, CreatedLease, InviteToken, NewCharge, LeaseChanges, LeaseTenantInput, NewLease,
    NewMaintenance, NewPayment, NewRefreshToken, NewTenant, PropertyInput, TenantChanges, UnitInput,
} from "../types/inputs"
import type {
    BankAccountRecord, ChargeRecord, InvitedTenant, LeaseBalance, LeaseRecord, LeaseResident, LeaseWithUnit,
    MaintenanceRecord, MaintenanceState, OpenRequestCount, PaymentRecord, PersonRecord, PropertyRecord,
    Receipt, RecentPaymentRecord, SessionUser, StaffProfile, TenantMaintenanceRecord, UnitRecord, UserRecord,
} from "../types/records"
import type { DatabaseInterface } from "../types/stores"
import { isStaffRole, type Role } from "../types/access"
import { AppError } from "../types/errors"
import { OFFICE_PAYMENT_PREFIX, reversalConfirmation } from "../utils/confirmations"
import { adminId, parseUserId, tenantId } from "../utils/user-id"
import { currentIdentity, SYSTEM, settingsFor, type Identity } from "./identity"

/**
 * Every SQL statement the app runs. Columns are aliased to the record field
 * names in types/records.ts, so rows come back as records. Values only ever
 * reach SQL as bind parameters.
 *
 * Each call is one transaction that starts by telling Postgres who is asking
 * (db/identity.ts); row-level security does the rest, and with no identity
 * every query comes back empty. Checks that must read before writing ("is the
 * unit free") stay here, inside that transaction.
 */

// NUMERIC (money) as a number of dollars, and DATE as "YYYY-MM-DD" instead of a local-midnight Date.
types.setTypeParser(types.builtins.NUMERIC, Number)
types.setTypeParser(types.builtins.DATE, (value) => value)

const PROPERTY = `p.pID AS id, p.Name AS name, p.Address AS address`
const PERSON = `t.tID AS id, t.Name AS name, t.Email AS email, t.Phone AS phone, t.signup_completed AS "signedUp"`
const LEASE = `l.LeaseID AS id, l.uID AS "unitId", l.start_date AS "startDate", l.end_date AS "endDate", l.monthly_rent AS "monthlyRent"`
const LEASE_WITH_UNIT = `${LEASE}, u.UnitNum AS "unitNum", p.pID AS "propertyId", p.Name AS "propertyName", p.Address AS address`
const CHARGE = `c.chargeID AS id, c.LeaseID AS "leaseId", c.kind, c.amount, c.due_date AS "dueDate", c.description`
const PAYMENT = `p.payID AS id, p.LeaseID AS "leaseId", p.direction, p.status, p.amount, p."timestamp" AS "paidAt",
    d.method, p.transaction_id AS confirmation, d.tID AS "payerId"`
const BANK = `bID AS id, name, mask, subtype`

/** The lease is in effect on $2. */
const ACTIVE_ON = "l.start_date <= $2::date AND (l.end_date IS NULL OR l.end_date >= $2::date)"
/** The lease has not ended by $1 (current or still to come). */
const NOT_ENDED = "(l.end_date IS NULL OR l.end_date >= $1::date)"

const PG = { unique: "23505", check: "23514", exclusion: "23P01", privilege: "42501" }
const hasCode = (error: unknown, ...codes: string[]) => codes.includes((error as { code?: string }).code ?? "")

type UserType = "tenant" | "admin"
const userIdOf = (type: UserType, id: number) => (type === "tenant" ? tenantId(id) : adminId(id))
/** The app's role for an account row: tenants are 'tenant'; staff take Admin.role ('admin' or 'maintenance_staff'). */
const roleOf = (type: UserType, adminRole: string | null): Role => {
    if (type === "tenant") return "tenant"
    if (adminRole && isStaffRole(adminRole)) return adminRole
    throw new Error(`unknown staff role: ${adminRole}`)
}

export class PostgresDatabase implements DatabaseInterface {
    constructor(private readonly pool: Pool) {}

    /** Run `work` in one transaction as `as` (by default, whoever the current request is for). */
    private async tx<T>(work: (client: PoolClient) => Promise<T>, as: Identity = currentIdentity()): Promise<T> {
        const client = await this.pool.connect()
        let broken = false
        try {
            await client.query("BEGIN")
            const [type, id, role] = settingsFor(as)
            // `true`: local to this transaction, so a pooled connection never carries an identity to the next caller.
            await client.query(
                "SELECT set_config('app.user_type', $1, true), set_config('app.user_id', $2, true), set_config('app.user_role', $3, true)",
                [type, id, role],
            )
            const result = await work(client)
            await client.query("COMMIT")
            return result
        } catch (error) {
            try { await client.query("ROLLBACK") } catch { broken = true }
            throw error
        } finally {
            client.release(broken)
        }
    }

    private query<R extends QueryResultRow>(sql: string, params: unknown[] = [], as?: Identity): Promise<QueryResult<R>> {
        return this.tx((client) => client.query<R>(sql, params), as)
    }

    async checkHealth(): Promise<void> {
        await this.pool.query("SELECT 1")
    }

    // ---- Accounts and sessions (through the schema's SECURITY DEFINER auth_* functions)

    async findUserByEmail(email: string): Promise<UserRecord | null> {
        const { rows } = await this.query<{ user_type: UserType; user_id: number; password_hash: string | null; signup_completed: boolean; role: string | null; mfa_enabled: boolean }>(
            "SELECT user_type, user_id, password_hash, signup_completed, role, mfa_enabled FROM auth_lookup_user($1)",
            [email],
        )
        // An invited tenant has no password yet and cannot sign in.
        const row = rows.find((r) => r.signup_completed && r.password_hash)
        if (!row) return null
        return { id: userIdOf(row.user_type, row.user_id), email, passwordHash: row.password_hash!, role: roleOf(row.user_type, row.role), mfaEnabled: row.mfa_enabled }
    }

    async completeSignup(tokenHash: string, passwordHash: string): Promise<UserRecord | null> {
        // One UPDATE checks the token, its expiry and the tenant's state, so two racing requests cannot both win.
        const signup = await this.query<{ tid: number | null }>("SELECT auth_complete_signup($1, $2) AS tid", [tokenHash, passwordHash])
        const tid = signup.rows[0]?.tid
        if (!tid) return null
        const { rows } = await this.query<{ email: string }>("SELECT Email AS email FROM Tenants WHERE tID = $1", [tid], { type: "tenant", id: tid })
        return { id: tenantId(tid), email: rows[0]?.email ?? "", passwordHash, role: "tenant", mfaEnabled: false }
    }

    async findStaffProfile(adminID: number): Promise<StaffProfile | null> {
        const { rows } = await this.query<StaffProfile>("SELECT name, email, role FROM Admin WHERE admin_id = $1", [adminID])
        return rows[0] ?? null
    }

    async storeRefreshToken(data: NewRefreshToken): Promise<void> {
        const owner = parseUserId(data.userId)
        if (!owner) throw new Error(`not a user id: ${data.userId}`)
        await this.query("SELECT auth_store_refresh_token($1, $2, $3, $4)", [owner.table, owner.id, data.tokenHash, data.expiresAt])
    }

    async consumeRefreshToken(tokenHash: string): Promise<SessionUser | null> {
        const { rows } = await this.query<{ user_type: UserType; user_id: number; email: string; role: string | null }>(
            "SELECT user_type, user_id, email, role FROM auth_consume_refresh_token($1)",
            [tokenHash],
        )
        const row = rows[0]
        return row ? { id: userIdOf(row.user_type, row.user_id), email: row.email, role: roleOf(row.user_type, row.role) } : null
    }

    async revokeRefreshToken(tokenHash: string): Promise<void> {
        await this.query("SELECT auth_revoke_refresh_token($1)", [tokenHash])
    }

    async revokeAllTokensForUser(userId: string): Promise<void> {
        const owner = parseUserId(userId)
        if (owner) await this.query("SELECT auth_revoke_all_tokens($1, $2)", [owner.table, owner.id])
    }

    // ---- Properties and units

    async listProperties(): Promise<PropertyRecord[]> {
        return (await this.query<PropertyRecord>(`SELECT ${PROPERTY} FROM Property p WHERE p.deactivated_at IS NULL ORDER BY p.Name`)).rows
    }

    async countProperties(): Promise<number> {
        return (await this.query<{ n: number }>("SELECT count(*)::int AS n FROM Property WHERE deactivated_at IS NULL")).rows[0]!.n
    }

    async listUnits(propertyId?: number): Promise<UnitRecord[]> {
        const { rows } = await this.query<UnitRecord>(
            `SELECT u.uID AS id, u.pID AS "propertyId", p.Name AS "propertyName", u.UnitNum AS "unitNum"
             FROM Units u JOIN Property p ON p.pID = u.pID
             WHERE u.deactivated_at IS NULL AND p.deactivated_at IS NULL AND ($1::int IS NULL OR u.pID = $1)
             ORDER BY p.Name, u.UnitNum`,
            [propertyId ?? null],
        )
        return rows
    }

    async saveProperty(id: number | null, input: PropertyInput): Promise<number> {
        if (id === null) {
            const { rows } = await this.query<{ id: number }>("INSERT INTO Property (Name, Address) VALUES ($1, $2) RETURNING pID AS id", [input.name, input.address])
            return rows[0]!.id
        }
        const result = await this.query("UPDATE Property SET Name = $2, Address = $3 WHERE pID = $1 AND deactivated_at IS NULL", [id, input.name, input.address])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
        return id
    }

    async saveUnit(id: number | null, input: UnitInput): Promise<number> {
        return this.tx(async (client) => {
            const property = await client.query("SELECT 1 FROM Property WHERE pID = $1 AND deactivated_at IS NULL", [input.propertyId])
            if (!property.rowCount) throw new AppError("NOT_FOUND")
            // The schema's UNIQUE (pID, UnitNum) is case-sensitive; "1a" and "1A" should clash.
            const duplicate = await client.query(
                "SELECT 1 FROM Units WHERE pID = $1 AND lower(UnitNum) = lower($2) AND ($3::int IS NULL OR uID <> $3)",
                [input.propertyId, input.unitNum, id],
            )
            if (duplicate.rowCount) throw new AppError("VALIDATION_ERROR")
            try {
                if (id === null) {
                    const { rows } = await client.query<{ id: number }>("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS id", [input.propertyId, input.unitNum])
                    return rows[0]!.id
                }
                const result = await client.query("UPDATE Units SET pID = $2, UnitNum = $3 WHERE uID = $1 AND deactivated_at IS NULL", [id, input.propertyId, input.unitNum])
                if (!result.rowCount) throw new AppError("NOT_FOUND")
                return id
            } catch (error) {
                if (hasCode(error, PG.unique)) throw new AppError("VALIDATION_ERROR")
                throw error
            }
        })
    }

    async deactivateUnit(uID: number, today: string): Promise<void> {
        await this.tx(async (client) => {
            const unit = await client.query("SELECT 1 FROM Units WHERE uID = $1 AND deactivated_at IS NULL FOR UPDATE", [uID])
            if (!unit.rowCount) throw new AppError("NOT_FOUND")
            const leased = await client.query(`SELECT 1 FROM Lease l WHERE l.uID = $2 AND ${NOT_ENDED} LIMIT 1`, [today, uID])
            if (leased.rowCount) throw new AppError("UNIT_HAS_LEASES")
            await client.query("UPDATE Units SET deactivated_at = now() WHERE uID = $1", [uID])
        })
    }

    async deactivateProperty(pID: number, today: string): Promise<void> {
        await this.tx(async (client) => {
            const property = await client.query("SELECT 1 FROM Property WHERE pID = $1 AND deactivated_at IS NULL FOR UPDATE", [pID])
            if (!property.rowCount) throw new AppError("NOT_FOUND")
            const leased = await client.query(`SELECT 1 FROM Lease l JOIN Units u ON u.uID = l.uID WHERE u.pID = $2 AND ${NOT_ENDED} LIMIT 1`, [today, pID])
            if (leased.rowCount) throw new AppError("PROPERTY_HAS_LEASES")
            await client.query("UPDATE Units SET deactivated_at = now() WHERE pID = $1 AND deactivated_at IS NULL", [pID])
            await client.query("UPDATE Property SET deactivated_at = now() WHERE pID = $1", [pID])
        })
    }

    // ---- Tenants

    async listPeople(): Promise<PersonRecord[]> {
        return (await this.query<PersonRecord>(`SELECT ${PERSON} FROM Tenants t WHERE t.deactivated_at IS NULL ORDER BY t.Name`)).rows
    }

    async findPerson(tID: number): Promise<PersonRecord | null> {
        const { rows } = await this.query<PersonRecord>(`SELECT ${PERSON} FROM Tenants t WHERE t.tID = $1 AND t.deactivated_at IS NULL`, [tID])
        return rows[0] ?? null
    }

    async inviteTenant(data: NewTenant): Promise<InvitedTenant> {
        return this.tx(async (client) => {
            const { tid, ...person } = await this.insertTenant(client, data)
            return { id: tenantId(tid), ...person }
        })
    }

    /** One invited tenant (no password yet), inside the caller's transaction. */
    private async insertTenant(client: PoolClient, data: NewTenant) {
        try {
            const { rows } = await client.query<{ tid: number; name: string; email: string; phone: string | null }>(
                `INSERT INTO Tenants (Name, Phone, Email, signup_token_hash, signup_token_expires_at) VALUES ($1, $2, $3, $4, $5)
                 RETURNING tID AS tid, Name AS name, Email AS email, Phone AS phone`,
                [data.name, data.phone ?? null, data.email.trim().toLowerCase(), data.invite.tokenHash, data.invite.expiresAt],
            )
            return rows[0]!
        } catch (error) {
            if (hasCode(error, PG.unique)) throw new AppError("EMAIL_IN_USE")
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")   // e.g. not an email address
            throw error
        }
    }

    async reissueInvite(tID: number, invite: InviteToken): Promise<void> {
        await this.tx(async (client) => {
            const { rows } = await client.query<{ signup_completed: boolean }>(
                "SELECT signup_completed FROM Tenants WHERE tID = $1 AND deactivated_at IS NULL FOR UPDATE",
                [tID],
            )
            if (!rows[0]) throw new AppError("NOT_FOUND")
            if (rows[0].signup_completed) throw new AppError("TENANT_ALREADY_SIGNED_UP")
            await client.query("UPDATE Tenants SET signup_token_hash = $2, signup_token_expires_at = $3 WHERE tID = $1", [tID, invite.tokenHash, invite.expiresAt])
        })
    }

    async resetSignIn(tID: number, invite: InviteToken): Promise<void> {
        await this.tx(async (client) => {
            const { rows } = await client.query<{ signup_completed: boolean }>(
                "SELECT signup_completed FROM Tenants WHERE tID = $1 AND deactivated_at IS NULL FOR UPDATE",
                [tID],
            )
            if (!rows[0]) throw new AppError("NOT_FOUND")
            if (!rows[0].signup_completed) throw new AppError("TENANT_NOT_SIGNED_UP")
            // Back to "invited": 001's signup_password_consistency needs both columns to change together.
            await client.query(
                `UPDATE Tenants SET password_hash = NULL, signup_completed = false, signup_token_hash = $2, signup_token_expires_at = $3
                 WHERE tID = $1`,
                [tID, invite.tokenHash, invite.expiresAt],
            )
            await client.query("SELECT auth_revoke_all_tokens('tenant', $1)", [tID])
        })
    }

    async updateTenant(tID: number, changes: TenantChanges): Promise<void> {
        const result = await this.query("UPDATE Tenants SET Name = $2, Phone = $3 WHERE tID = $1 AND deactivated_at IS NULL", [tID, changes.name, changes.phone])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    async deactivateTenant(tID: number, today: string): Promise<void> {
        await this.tx(async (client) => {
            const tenant = await client.query("SELECT 1 FROM Tenants WHERE tID = $1 AND deactivated_at IS NULL FOR UPDATE", [tID])
            if (!tenant.rowCount) throw new AppError("NOT_FOUND")
            const onLease = await client.query(
                `SELECT 1 FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID WHERE lt.tID = $2 AND ${NOT_ENDED} LIMIT 1`,
                [today, tID],
            )
            if (onLease.rowCount) throw new AppError("TENANT_ON_LEASE")
            await client.query("UPDATE Tenants SET deactivated_at = now() WHERE tID = $1", [tID])
            await client.query("SELECT auth_revoke_all_tokens('tenant', $1)", [tID])
        })
    }

    // ---- Leases

    async listLeases(): Promise<LeaseRecord[]> {
        return (await this.query<LeaseRecord>(`SELECT ${LEASE} FROM Lease l ORDER BY l.LeaseID`)).rows
    }

    async findLease(leaseId: number): Promise<LeaseWithUnit | null> {
        const { rows } = await this.query<LeaseWithUnit>(
            `SELECT ${LEASE_WITH_UNIT} FROM Lease l JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID WHERE l.LeaseID = $1`,
            [leaseId],
        )
        return rows[0] ?? null
    }

    async findCurrentLease(tID: number, today: string): Promise<LeaseWithUnit | null> {
        const { rows } = await this.query<LeaseWithUnit>(
            `SELECT ${LEASE_WITH_UNIT}
             FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
             WHERE lt.tID = $1 AND ${ACTIVE_ON}
             ORDER BY l.start_date DESC, l.LeaseID DESC
             LIMIT 1`,
            [tID, today],
        )
        return rows[0] ?? null
    }

    async listLeaseResidents(): Promise<LeaseResident[]> {
        const { rows } = await this.query<LeaseResident>(
            `SELECT lt.LeaseID AS "leaseId", t.tID AS "tenantId", t.Name AS name FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID ORDER BY t.Name`,
        )
        return rows
    }

    async listLeaseTenants(leaseId: number): Promise<PersonRecord[]> {
        const { rows } = await this.query<PersonRecord>(
            `SELECT ${PERSON} FROM Lease_Tenants lt JOIN Tenants t ON t.tID = lt.tID WHERE lt.LeaseID = $1 ORDER BY t.Name`,
            [leaseId],
        )
        return rows
    }

    async createLease(input: NewLease, today: string): Promise<CreatedLease> {
        return this.tx(async (client) => {
            const unit = await client.query<{ inactive: boolean }>("SELECT deactivated_at IS NOT NULL AS inactive FROM Units WHERE uID = $1", [input.unitId])
            if (!unit.rows[0]) throw new AppError("NOT_FOUND")
            if (unit.rows[0].inactive) throw new AppError("UNIT_INACTIVE")

            const existing = [...new Set(input.tenantIds)]
            if (existing.length) {
                const found = await client.query("SELECT 1 FROM Tenants WHERE tID = ANY($1::int[]) AND deactivated_at IS NULL", [existing])
                if (found.rowCount !== existing.length) throw new AppError("NOT_FOUND")
            }
            const newTenantIds: number[] = []
            for (const person of input.newTenants) {
                newTenantIds.push((await this.insertTenant(client, person)).tid)
            }

            let leaseId: number
            try {
                // The schema refuses a second lease that overlaps in time on the same unit.
                const { rows } = await client.query<{ id: number }>(
                    "INSERT INTO Lease (uID, start_date, end_date, monthly_rent) VALUES ($1, $2, $3, $4) RETURNING LeaseID AS id",
                    [input.unitId, input.startDate, input.endDate, input.monthlyRent.toFixed(2)],
                )
                leaseId = rows[0]!.id
            } catch (error) {
                if (hasCode(error, PG.exclusion)) throw new AppError("UNIT_OCCUPIED")
                if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
                throw error
            }
            for (const tID of [...existing, ...newTenantIds]) {
                await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [leaseId, tID])
            }
            // Bill the months already due, so the lease opens with the right balance.
            await client.query("SELECT generate_rent_charges($1::date, $2::int)", [today, leaseId])
            return { leaseId, newTenantIds }
        })
    }

    async updateLease(leaseId: number, changes: LeaseChanges): Promise<void> {
        await this.tx(async (client) => {
            const current = await client.query<{ start: string }>("SELECT start_date AS start FROM Lease WHERE LeaseID = $1 FOR UPDATE", [leaseId])
            if (!current.rows[0]) throw new AppError("NOT_FOUND")
            if (changes.endDate && changes.endDate < current.rows[0].start) throw new AppError("VALIDATION_ERROR")
            try {
                await client.query(
                    `UPDATE Lease
                     SET monthly_rent = COALESCE($2::numeric, monthly_rent),
                         end_date = CASE WHEN $3::boolean THEN $4::date ELSE end_date END
                     WHERE LeaseID = $1`,
                    [leaseId, changes.monthlyRent?.toFixed(2) ?? null, changes.endDate !== undefined, changes.endDate ?? null],
                )
            } catch (error) {
                if (hasCode(error, PG.exclusion)) throw new AppError("UNIT_OCCUPIED")   // extended into the next lease
                if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
                throw error
            }
        })
    }

    async addTenantToLease(leaseId: number, input: LeaseTenantInput): Promise<number> {
        return this.tx(async (client) => {
            const lease = await client.query("SELECT 1 FROM Lease WHERE LeaseID = $1 FOR UPDATE", [leaseId])
            if (!lease.rowCount) throw new AppError("NOT_FOUND")
            let tID = input.tenantId
            if (input.newTenant) {
                tID = (await this.insertTenant(client, input.newTenant)).tid
            } else if (tID) {
                const tenant = await client.query("SELECT 1 FROM Tenants WHERE tID = $1 AND deactivated_at IS NULL", [tID])
                if (!tenant.rowCount) throw new AppError("NOT_FOUND")
            }
            if (!tID) throw new AppError("VALIDATION_ERROR")
            await client.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2) ON CONFLICT DO NOTHING", [leaseId, tID])
            return tID
        })
    }

    async removeTenantFromLease(leaseId: number, tID: number): Promise<void> {
        await this.tx(async (client) => {
            // Lock the lease so two removals cannot each see two tenants and leave none.
            const lease = await client.query("SELECT 1 FROM Lease WHERE LeaseID = $1 FOR UPDATE", [leaseId])
            if (!lease.rowCount) throw new AppError("NOT_FOUND")
            const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM Lease_Tenants WHERE LeaseID = $1", [leaseId])
            if ((count.rows[0]?.n ?? 0) <= 1) throw new AppError("VALIDATION_ERROR")
            const result = await client.query("DELETE FROM Lease_Tenants WHERE LeaseID = $1 AND tID = $2", [leaseId, tID])
            if (!result.rowCount) throw new AppError("NOT_FOUND")
        })
    }

    // ---- Charges

    async listLeaseBalances(): Promise<LeaseBalance[]> {
        const { rows } = await this.query<LeaseBalance>(
            `SELECT LeaseID AS "leaseId", total_charged AS charged, total_paid AS paid, total_refunded AS refunded, balance FROM lease_balance`,
        )
        return rows
    }

    async listChargesForLease(leaseId: number): Promise<ChargeRecord[]> {
        return (await this.query<ChargeRecord>(`SELECT ${CHARGE} FROM Charge c WHERE c.LeaseID = $1 ORDER BY c.due_date, c.chargeID`, [leaseId])).rows
    }

    async generateRentCharges(today: string, leaseId?: number): Promise<number> {
        const { rows } = await this.query<{ n: number }>("SELECT generate_rent_charges($1::date, $2::int) AS n", [today, leaseId ?? null])
        return rows[0]?.n ?? 0
    }

    async addCharge(input: NewCharge): Promise<number> {
        return this.tx(async (client) => {
            const lease = await client.query("SELECT 1 FROM Lease WHERE LeaseID = $1", [input.leaseId])
            if (!lease.rowCount) throw new AppError("NOT_FOUND")
            try {
                const { rows } = await client.query<{ id: number }>(
                    "INSERT INTO Charge (LeaseID, kind, amount, due_date, description) VALUES ($1, $2, $3, $4, $5) RETURNING chargeID AS id",
                    [input.leaseId, input.kind, input.amount.toFixed(2), input.dueDate, input.description],
                )
                return rows[0]!.id
            } catch (error) {
                if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
                throw error
            }
        })
    }

    // ---- Payments and receipts

    async listPaymentsForLease(leaseId: number): Promise<PaymentRecord[]> {
        const { rows } = await this.query<PaymentRecord>(
            `SELECT ${PAYMENT} FROM Payment p LEFT JOIN Payment_Details d ON d.payID = p.payID WHERE p.LeaseID = $1 ORDER BY p."timestamp", p.payID`,
            [leaseId],
        )
        return rows
    }

    async listRecentPayments(limit: number): Promise<RecentPaymentRecord[]> {
        const { rows } = await this.query<RecentPaymentRecord>(
            `SELECT p.amount, p."timestamp" AS "paidAt", d.method, u.UnitNum AS "unitNum", t.Name AS payer
             FROM Payment p
             JOIN Lease l ON l.LeaseID = p.LeaseID
             JOIN Units u ON u.uID = l.uID
             LEFT JOIN Payment_Details d ON d.payID = p.payID
             LEFT JOIN Tenants t ON t.tID = d.tID
             WHERE p.status = 'completed' AND p.direction = 'charge'
             ORDER BY p."timestamp" DESC, p.payID DESC
             LIMIT $1`,
            [limit],
        )
        return rows
    }

    async listReceiptPaymentIds(leaseId: number): Promise<number[]> {
        const { rows } = await this.query<{ id: number }>(
            "SELECT r.payID AS id FROM Payment_Receipts r JOIN Payment p ON p.payID = r.payID WHERE p.LeaseID = $1",
            [leaseId],
        )
        return rows.map((r) => r.id)
    }

    async recordPayment(input: NewPayment): Promise<{ confirmation: string }> {
        const key = input.idempotencyKey ?? null
        // The payment already recorded under this key on this lease, if any.
        const earlier = async (client: PoolClient) => {
            if (key === null) return null
            const { rows } = await client.query<{ confirmation: string }>(
                "SELECT transaction_id AS confirmation FROM Payment WHERE idempotency_key = $1 AND LeaseID = $2",
                [key, input.leaseId],
            )
            return rows[0] ?? null
        }
        // As the caller: the lease exists and the payer is on it. RLS lets a tenant see only their own lease.
        const check = async (client: PoolClient) => {
            const lease = await client.query("SELECT 1 FROM Lease WHERE LeaseID = $1", [input.leaseId])
            if (!lease.rowCount) throw new AppError("NOT_FOUND")
            if (input.tenantId !== null) {
                const onLease = await client.query("SELECT 1 FROM Lease_Tenants WHERE LeaseID = $1 AND tID = $2", [input.leaseId, input.tenantId])
                if (!onLease.rowCount) throw new AppError("VALIDATION_ERROR")
            }
            return earlier(client)
        }
        // Null when another request with the same key got there first.
        const write = async (client: PoolClient) => {
            const { rows } = await client.query<{ id: number }>(
                `INSERT INTO Payment (LeaseID, direction, amount, status, transaction_id, idempotency_key)
                 VALUES ($1, 'charge', $2, 'completed', $3, $4)
                 ON CONFLICT (idempotency_key) DO NOTHING
                 RETURNING payID AS id`,
                [input.leaseId, input.amount.toFixed(2), input.confirmation, key],
            )
            const payId = rows[0]?.id
            if (payId === undefined) return null
            await client.query("INSERT INTO Payment_Details (payID, tID, method) VALUES ($1, $2, $3)", [payId, input.tenantId, input.method])
            if (input.receipt) await this.saveReceipt(client, payId, input.receipt)
            return { confirmation: input.confirmation }
        }
        const lost = async (): Promise<{ confirmation: string }> => {
            const first = await this.tx(earlier)
            if (!first) throw new AppError("VALIDATION_ERROR")   // the key belongs to another lease
            return first
        }

        if (currentIdentity().type === "admin") {   // staff (RLS refuses maintenance staff: no admin_all on Payment)
            const result = await this.tx(async (client) => (await check(client)) ?? (await write(client)))
            return result ?? lost()
        }
        // Tenants never write to the ledger themselves (schema rule): check as the tenant, then write as 'system'.
        if (input.receipt) throw new AppError("FORBIDDEN")
        const already = await this.tx(check)
        if (already) return already
        return (await this.tx(write, SYSTEM)) ?? lost()
    }

    async reverseOfficePayment(leaseId: number, payId: number): Promise<void> {
        await this.tx(async (client) => {
            const { rows } = await client.query<{ direction: string; amount: string; transaction_id: string }>(
                "SELECT direction, amount::text AS amount, transaction_id FROM Payment WHERE payID = $1 AND LeaseID = $2",
                [payId, leaseId],
            )
            const payment = rows[0]
            if (!payment) throw new AppError("NOT_FOUND")
            if (payment.direction !== "charge" || !payment.transaction_id.startsWith(OFFICE_PAYMENT_PREFIX)) throw new AppError("NOT_OFFICE_PAYMENT")
            try {
                // A refund row for the same amount; its unique idempotency key makes a second reversal fail.
                const refund = await client.query<{ id: number }>(
                    `INSERT INTO Payment (LeaseID, direction, amount, status, transaction_id, idempotency_key)
                     VALUES ($1, 'refund', $2, 'completed', $3, $4) RETURNING payID AS id`,
                    [leaseId, payment.amount, reversalConfirmation(payId), `reverse:${payId}`],
                )
                await client.query(
                    "INSERT INTO Payment_Details (payID, tID, method) VALUES ($1, NULL, $2)",
                    [refund.rows[0]!.id, `Reversal of payment ${payment.transaction_id}`.slice(0, 60)],
                )
            } catch (error) {
                if (hasCode(error, PG.unique)) throw new AppError("PAYMENT_ALREADY_REVERSED")
                throw error
            }
        })
    }

    async attachReceipt(leaseId: number, payId: number, receipt: Receipt): Promise<void> {
        await this.tx(async (client) => {
            const payment = await client.query("SELECT 1 FROM Payment WHERE payID = $1 AND LeaseID = $2", [payId, leaseId])
            if (!payment.rowCount) throw new AppError("NOT_FOUND")
            await this.saveReceipt(client, payId, receipt)
        })
    }

    async findReceipt(leaseId: number, payId: number): Promise<Receipt | null> {
        const { rows } = await this.query<Receipt>(
            `SELECT r.filename, r.content_type AS "contentType", r.data FROM Payment_Receipts r JOIN Payment p ON p.payID = r.payID
             WHERE r.payID = $1 AND p.LeaseID = $2`,
            [payId, leaseId],
        )
        return rows[0] ?? null
    }

    private async saveReceipt(client: PoolClient, payId: number, receipt: Receipt): Promise<void> {
        await client.query(
            `INSERT INTO Payment_Receipts (payID, filename, content_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (payID) DO UPDATE SET filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
               size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, uploaded_at = now()`,
            [payId, receipt.filename, receipt.contentType, receipt.data.length, receipt.data],
        )
    }

    // ---- Maintenance

    async listMaintenance(): Promise<MaintenanceRecord[]> {
        const { rows } = await this.query<MaintenanceRecord>(
            `SELECT m.mID AS id, m.title, m.description, m.status, m.created_at AS "createdAt", u.uID AS "unitId", u.UnitNum AS "unitNum",
                    p.Name AS "propertyName", t.Name AS "tenantName"
             FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID LEFT JOIN Tenants t ON t.tID = m.tID
             WHERE m.deactivated_at IS NULL
             ORDER BY (m.status = 'resolved'), m.created_at DESC, m.mID DESC`,
        )
        return rows
    }

    async listTenantMaintenance(tID: number): Promise<TenantMaintenanceRecord[]> {
        // RLS already limits a tenant to the units they lease today; the filter says so explicitly.
        const { rows } = await this.query<TenantMaintenanceRecord>(
            `SELECT m.mID AS id, m.title, m.description, m.status, m.created_at AS "createdAt"
             FROM Maintenance_T m
             WHERE m.deactivated_at IS NULL AND (m.tID = $1 OR tenant_has_active_lease_on(m.uID))
             ORDER BY m.created_at DESC, m.mID DESC`,
            [tID],
        )
        return rows
    }

    async listOpenRequestCounts(): Promise<OpenRequestCount[]> {
        const { rows } = await this.query<OpenRequestCount>(
            `SELECT uID AS "unitId", count(*)::int AS count FROM Maintenance_T WHERE status <> 'resolved' AND deactivated_at IS NULL GROUP BY uID`,
        )
        return rows
    }

    async createMaintenance(input: NewMaintenance): Promise<{ id: number; createdAt: Date }> {
        return this.tx(async (client) => {
            const unit = await client.query("SELECT 1 FROM Units WHERE uID = $1 AND deactivated_at IS NULL", [input.unitId])
            if (!unit.rowCount) throw new AppError("NOT_FOUND")
            try {
                const { rows } = await client.query<{ id: number; createdAt: Date }>(
                    `INSERT INTO Maintenance_T (uID, tID, title, description) VALUES ($1, $2, $3, $4) RETURNING mID AS id, created_at AS "createdAt"`,
                    [input.unitId, input.tenantId, input.title, input.description],
                )
                return rows[0]!
            } catch (error) {
                // RLS: a tenant may only file, as themselves, for a unit they lease today.
                if (hasCode(error, PG.privilege)) throw new AppError("FORBIDDEN")
                throw error
            }
        })
    }

    async setMaintenanceStatus(id: number, status: MaintenanceState): Promise<void> {
        const result = await this.query("UPDATE Maintenance_T SET status = $2 WHERE mID = $1 AND deactivated_at IS NULL", [id, status])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    async deactivateMaintenance(mID: number): Promise<void> {
        const result = await this.query("UPDATE Maintenance_T SET deactivated_at = now() WHERE mID = $1 AND deactivated_at IS NULL", [mID])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    // ---- Bank accounts

    async listBankAccounts(tID: number): Promise<BankAccountRecord[]> {
        return (await this.query<BankAccountRecord>(`SELECT ${BANK} FROM Bank_Accounts WHERE tID = $1 ORDER BY created_at, bID`, [tID])).rows
    }

    async findBankAccount(tID: number, bID: number): Promise<BankAccountRecord | null> {
        const { rows } = await this.query<BankAccountRecord>(`SELECT ${BANK} FROM Bank_Accounts WHERE bID = $1 AND tID = $2`, [bID, tID])
        return rows[0] ?? null
    }

    async saveBankAccounts(tID: number, item: BankItem, accounts: BankAccountInput[]): Promise<void> {
        await this.tx(async (client) => {
            for (const account of accounts) {
                await client.query(
                    `INSERT INTO Bank_Accounts (tID, plaid_item_id, plaid_account_id, access_token_enc, name, mask, subtype)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (tID, plaid_account_id) DO UPDATE
                       SET plaid_item_id = EXCLUDED.plaid_item_id, access_token_enc = EXCLUDED.access_token_enc,
                           name = EXCLUDED.name, mask = EXCLUDED.mask, subtype = EXCLUDED.subtype`,
                    [tID, item.itemId, account.accountId, item.accessTokenEnc, account.name, account.mask, account.subtype],
                )
            }
        })
    }
}
