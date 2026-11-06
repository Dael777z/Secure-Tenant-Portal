import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg"

import type { StaffRole } from "../types/access"
import type {
    AuditRow, ComplianceInput, ComplianceSettings, DepositRow, DocumentChange, HubDocument, HubFilter, LeadInput, LeadRow, LeadStatus,
    ListingInput, ListingRow, MaintenanceAttachment, MaintenanceDetail, MaintenanceNote, MaintenanceWorkInput, NewDocument, NoticeAudience,
    NoticeFilter, NoticeRow, PortfolioInput, PortfolioRecord, PropertyDetails, PropertyDetailsInput, PublicListing, SearchHit, SecurityEventRow,
    StaffInvite, StoredFile, TeamMember, TenantDetails, TenantDetailsInput, TenantDocument, TenantNotice, TenantPhoto, UploadedFile,
} from "../types/additions"
import { AppError } from "../types/errors"
import { currentIdentity, SYSTEM, type Identity } from "./identity"
import { inTransaction } from "./transaction"

const PG = { unique: "23505", check: "23514", foreignKey: "23503", privilege: "42501" }
const hasCode = (error: unknown, ...codes: string[]) => codes.includes((error as { code?: string }).code ?? "")
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value))
const UNIT_LABEL = `'Unit ' || u.UnitNum || ' - ' || p.Name`
/** Residents of a lease, comma-joined, oldest first. */
const RESIDENTS = (lease: string) =>
    `(SELECT string_agg(t2.Name, ', ' ORDER BY t2.tID) FROM Lease_Tenants lt2 JOIN Tenants t2 ON t2.tID = lt2.tID WHERE lt2.LeaseID = ${lease})`
/** The lease on a unit today, if any. */
const CURRENT_LEASE = (unit: string, day = "$1::date") =>
    `(SELECT l.LeaseID FROM Lease l WHERE l.uID = ${unit} AND l.start_date <= ${day} AND (l.end_date IS NULL OR l.end_date >= ${day}) ORDER BY l.start_date DESC LIMIT 1)`
/** "Name" for an "admin:3" / "tenant:5" / "system" actor. */
const ACTOR_NAME = (actor: string) => `(CASE
        WHEN ${actor} = 'system' THEN 'System'
        WHEN ${actor} LIKE 'admin:%' THEN (SELECT a.name FROM Admin a WHERE a.admin_id = substr(${actor}, 7)::int)
        WHEN ${actor} LIKE 'tenant:%' THEN (SELECT t.Name FROM Tenants t WHERE t.tID = substr(${actor}, 8)::int)
    END)`

/**
 * The 009 queries: office tools, maintenance detail, documents, notices and
 * listings. Same rules as PostgresDatabase: one transaction per call, run as
 * the request's identity so row-level security decides what is visible, and
 * values only as bind parameters.
 */
export class PostgresAdditions {
    constructor(private readonly pool: Pool) {}

    private tx<T>(work: (client: PoolClient) => Promise<T>, as: Identity = currentIdentity()): Promise<T> {
        return inTransaction(this.pool, work, as)
    }

    private query<R extends QueryResultRow>(sql: string, params: unknown[] = [], as?: Identity): Promise<QueryResult<R>> {
        return this.tx((client) => client.query<R>(sql, params), as)
    }

    /* ================================================================ Team */

    async listTeam(): Promise<TeamMember[]> {
        const { rows } = await this.query<TeamMember & { lastLoginAt: Date | null }>(
            `SELECT admin_id AS id, name, email::text AS email, role,
                    CASE WHEN deactivated_at IS NOT NULL THEN 'deactivated' WHEN NOT signup_completed THEN 'invited' ELSE 'active' END AS status,
                    mfa_enabled AS "mfaEnabled", last_login_at AS "lastLoginAt"
             FROM Admin
             ORDER BY (deactivated_at IS NOT NULL), lower(name), admin_id`,
        )
        return rows.map((r) => ({ ...r, lastLoginAt: iso(r.lastLoginAt) }))
    }

    async findTeamMember(id: number): Promise<TeamMember | null> {
        return (await this.listTeam()).find((m) => m.id === id) ?? null
    }

    /** An active property manager other than `except`, so the last one can't be demoted or removed. */
    async countOtherActiveManagers(except: number): Promise<number> {
        const { rows } = await this.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM Admin WHERE role = 'admin' AND deactivated_at IS NULL AND signup_completed AND admin_id <> $1",
            [except],
        )
        return rows[0]!.n
    }

    async inviteStaff(input: { name: string; email: string; role: StaffRole; invite: StaffInvite }): Promise<number> {
        try {
            const { rows } = await this.query<{ id: number }>(
                `INSERT INTO Admin (name, email, role, password_hash, signup_completed, signup_token_hash, signup_token_expires_at)
                 VALUES ($1, $2, $3, NULL, false, $4, $5) RETURNING admin_id AS id`,
                [input.name, input.email, input.role, input.invite.tokenHash, input.invite.expiresAt],
            )
            return rows[0]!.id
        } catch (error) {
            if (hasCode(error, PG.unique)) throw new AppError("EMAIL_IN_USE")
            throw error
        }
    }

    async updateStaff(id: number, input: { name?: string; role?: StaffRole }): Promise<void> {
        const result = await this.query(
            "UPDATE Admin SET name = COALESCE($2, name), role = COALESCE($3, role) WHERE admin_id = $1 AND deactivated_at IS NULL",
            [id, input.name ?? null, input.role ?? null],
        )
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /** Signs them out everywhere too. */
    async deactivateStaff(id: number): Promise<void> {
        await this.tx(async (client) => {
            const result = await client.query(
                "UPDATE Admin SET deactivated_at = now(), signup_token_hash = NULL, signup_token_expires_at = NULL WHERE admin_id = $1 AND deactivated_at IS NULL",
                [id],
            )
            if (!result.rowCount) throw new AppError("NOT_FOUND")
            await client.query("SELECT auth_revoke_all_tokens('admin', $1)", [id])
        })
    }

    /** A new link for someone who has not signed up yet; the old link stops working. */
    async reissueStaffInvite(id: number, invite: StaffInvite): Promise<void> {
        const result = await this.query(
            `UPDATE Admin SET signup_token_hash = $2, signup_token_expires_at = $3
             WHERE admin_id = $1 AND deactivated_at IS NULL AND NOT signup_completed`,
            [id, invite.tokenHash, invite.expiresAt],
        )
        if (!result.rowCount) throw new AppError("STAFF_ALREADY_SIGNED_UP")
    }

    /** Forgot their password: the old one and every session stop working, and a link lets them choose a new one. */
    async resetStaffSignIn(id: number, invite: StaffInvite): Promise<void> {
        await this.tx(async (client) => {
            const result = await client.query(
                `UPDATE Admin SET password_hash = NULL, signup_completed = false, mfa_enabled = false, mfa_secret_encrypted = NULL,
                        signup_token_hash = $2, signup_token_expires_at = $3
                 WHERE admin_id = $1 AND deactivated_at IS NULL AND signup_completed`,
                [id, invite.tokenHash, invite.expiresAt],
            )
            if (!result.rowCount) throw new AppError("STAFF_NOT_SIGNED_UP")
            await client.query("SELECT auth_revoke_all_tokens('admin', $1)", [id])
        })
    }

    async recordSecurityEvent(actor: string | null, action: string, summary: string, details: Record<string, unknown> | null = null): Promise<void> {
        await this.query("SELECT record_security_event($1, $2, $3, $4)", [actor, action, summary, details === null ? null : JSON.stringify(details)], SYSTEM)
    }

    /* ============================================================ Activity */

    async listAudit(table: string | null, since: string | null, limit: number): Promise<AuditRow[]> {
        const { rows } = await this.query<{ at: Date; by: string | null; table: string; rowPk: string; action: AuditRow["action"]; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
            `SELECT changed_at AS at, changed_by AS by, table_name AS "table", row_pk AS "rowPk", action, old_data AS before, new_data AS after
             FROM read_audit_log($1, NULL, $2::timestamptz, $3)`,
            [table, since, limit],
        )
        return rows.map((r) => ({ ...r, at: r.at.toISOString() }))
    }

    async listSecurityEvents(since: string | null, limit: number): Promise<SecurityEventRow[]> {
        const { rows } = await this.query<{ at: Date; by: string | null; action: string; summary: string; details: unknown }>(
            `SELECT at, actor AS by, action, summary, details FROM Security_Events
             WHERE ($1::timestamptz IS NULL OR at >= $1::timestamptz) ORDER BY at DESC, eventID DESC LIMIT $2`,
            [since, limit],
        )
        return rows.map((r) => ({ ...r, at: r.at.toISOString() }))
    }

    /** Names for "admin:3" / "tenant:5" actors. */
    async actorNames(actors: string[]): Promise<Map<string, string>> {
        const unique = [...new Set(actors.filter((a) => /^(admin|tenant):\d+$/.test(a) || a === "system"))]
        if (unique.length === 0) return new Map()
        const { rows } = await this.query<{ actor: string; name: string | null }>(
            `SELECT a AS actor, ${ACTOR_NAME("a")} AS name FROM unnest($1::text[]) AS a`,
            [unique],
        )
        return new Map(rows.filter((r) => r.name).map((r) => [r.actor, r.name!]))
    }

    /* ========================================================== Portfolios */

    async listPortfolios(): Promise<Array<PortfolioRecord & { properties: Array<{ id: number; name: string; address: string }>; units: number; occupied: number; monthlyRent: number; outstanding: number }>> {
        const { rows } = await this.query<PortfolioRecord & { createdAt: Date; properties: Array<{ id: number; name: string; address: string }> | null; units: number; occupied: number; monthlyRent: number; outstanding: number }>(
            `WITH units AS (
                 SELECT u.uID, u.pID, ${CURRENT_LEASE("u.uID", "current_date")} AS lease_id
                 FROM Units u WHERE u.deactivated_at IS NULL)
             SELECT f.portfolio_id AS id, f.name::text AS name, f.entity_name AS "entityName", f.notes, a.name AS "createdBy", f.created_at AS "createdAt",
                    (SELECT json_agg(json_build_object('id', p.pID, 'name', p.Name, 'address', p.Address) ORDER BY p.Name)
                     FROM Property p WHERE p.portfolio_id = f.portfolio_id AND p.deactivated_at IS NULL) AS properties,
                    (SELECT count(*)::int FROM units x JOIN Property p ON p.pID = x.pID WHERE p.portfolio_id = f.portfolio_id AND p.deactivated_at IS NULL) AS units,
                    (SELECT count(x.lease_id)::int FROM units x JOIN Property p ON p.pID = x.pID WHERE p.portfolio_id = f.portfolio_id AND p.deactivated_at IS NULL) AS occupied,
                    (SELECT COALESCE(sum(l.monthly_rent), 0) FROM units x JOIN Property p ON p.pID = x.pID JOIN Lease l ON l.LeaseID = x.lease_id
                     WHERE p.portfolio_id = f.portfolio_id AND p.deactivated_at IS NULL) AS "monthlyRent",
                    (SELECT COALESCE(sum(GREATEST(b.balance, 0)), 0) FROM lease_balance b JOIN Lease l ON l.LeaseID = b.LeaseID JOIN Units u ON u.uID = l.uID
                     JOIN Property p ON p.pID = u.pID WHERE p.portfolio_id = f.portfolio_id) AS outstanding
             FROM Portfolios f LEFT JOIN Admin a ON a.admin_id = f.created_by
             WHERE f.retired_at IS NULL
             ORDER BY f.name`,
        )
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), properties: r.properties ?? [] }))
    }

    async listUnassignedProperties(): Promise<Array<{ id: number; name: string; address: string }>> {
        const { rows } = await this.query<{ id: number; name: string; address: string }>(
            "SELECT pID AS id, Name AS name, Address AS address FROM Property WHERE portfolio_id IS NULL AND deactivated_at IS NULL ORDER BY Name",
        )
        return rows
    }

    async savePortfolio(id: number | null, input: PortfolioInput): Promise<number> {
        try {
            if (id === null) {
                const { rows } = await this.query<{ id: number }>(
                    "INSERT INTO Portfolios (name, entity_name, notes, created_by) VALUES ($1, $2, $3, NULLIF(current_setting('app.user_id', true), '')::int) RETURNING portfolio_id AS id",
                    [input.name, input.entityName, input.notes],
                )
                return rows[0]!.id
            }
            const result = await this.query(
                "UPDATE Portfolios SET name = $2, entity_name = $3, notes = $4 WHERE portfolio_id = $1 AND retired_at IS NULL",
                [id, input.name, input.entityName, input.notes],
            )
            if (!result.rowCount) throw new AppError("NOT_FOUND")
            return id
        } catch (error) {
            if (hasCode(error, PG.unique)) throw new AppError("NAME_IN_USE")
            throw error
        }
    }

    /** Its properties go back to "not in a portfolio". */
    async retirePortfolio(id: number): Promise<void> {
        await this.tx(async (client) => {
            const result = await client.query("UPDATE Portfolios SET retired_at = now() WHERE portfolio_id = $1 AND retired_at IS NULL", [id])
            if (!result.rowCount) throw new AppError("NOT_FOUND")
            await client.query("UPDATE Property SET portfolio_id = NULL WHERE portfolio_id = $1", [id])
        })
    }

    async propertyDetails(id: number): Promise<PropertyDetails | null> {
        const { rows } = await this.query<PropertyDetails>(
            `SELECT p.pID AS "propertyId", p.Name AS name, p.Address AS address, p.portfolio_id AS "portfolioId", f.name::text AS "portfolioName",
                    p.city, p.state, p.zip, p.time_zone AS "timeZone", p.notes
             FROM Property p LEFT JOIN Portfolios f ON f.portfolio_id = p.portfolio_id AND f.retired_at IS NULL
             WHERE p.pID = $1 AND p.deactivated_at IS NULL`,
            [id],
        )
        return rows[0] ?? null
    }

    async savePropertyDetails(id: number, input: PropertyDetailsInput): Promise<void> {
        try {
            const result = await this.query(
                `UPDATE Property SET portfolio_id = $2, city = $3, state = $4, zip = $5, time_zone = $6, notes = $7
                 WHERE pID = $1 AND deactivated_at IS NULL
                   AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM Portfolios f WHERE f.portfolio_id = $2 AND f.retired_at IS NULL))`,
                [id, input.portfolioId, input.city, input.state, input.zip, input.timeZone, input.notes],
            )
            if (!result.rowCount) throw new AppError(input.portfolioId === null ? "NOT_FOUND" : "VALIDATION_ERROR")
        } catch (error) {
            if (hasCode(error, PG.check, PG.foreignKey)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }

    async tenantDetails(tID: number): Promise<TenantDetails | null> {
        const { rows } = await this.query<TenantDetails & { updatedAt: Date | null }>(
            `SELECT t.tID AS "tenantId", d.notes, COALESCE(d.insurance_status, 'not_required') AS "insuranceStatus",
                    d.insurance_expires AS "insuranceExpires", d.emergency_contact_name AS "emergencyContactName",
                    d.emergency_contact_phone AS "emergencyContactPhone", d.updated_at AS "updatedAt", a.name AS "updatedBy"
             FROM Tenants t LEFT JOIN Tenant_Details d ON d.tID = t.tID LEFT JOIN Admin a ON a.admin_id = d.updated_by
             WHERE t.tID = $1 AND t.deactivated_at IS NULL`,
            [tID],
        )
        const row = rows[0]
        return row ? { ...row, updatedAt: iso(row.updatedAt) } : null
    }

    async saveTenantDetails(tID: number, input: TenantDetailsInput): Promise<void> {
        await this.tx(async (client) => {
            const exists = await client.query("SELECT 1 FROM Tenants WHERE tID = $1 AND deactivated_at IS NULL", [tID])
            if (!exists.rowCount) throw new AppError("NOT_FOUND")
            await client.query(
                `INSERT INTO Tenant_Details (tID, notes, insurance_status, insurance_expires, emergency_contact_name, emergency_contact_phone, updated_by, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NULLIF(current_setting('app.user_id', true), '')::int, now())
                 ON CONFLICT (tID) DO UPDATE SET notes = EXCLUDED.notes, insurance_status = EXCLUDED.insurance_status,
                     insurance_expires = EXCLUDED.insurance_expires, emergency_contact_name = EXCLUDED.emergency_contact_name,
                     emergency_contact_phone = EXCLUDED.emergency_contact_phone, updated_by = EXCLUDED.updated_by, updated_at = now()`,
                [tID, input.notes, input.insuranceStatus, input.insuranceExpires, input.emergencyContactName, input.emergencyContactPhone],
            )
        })
    }

    /* ========================================================== Compliance */

    async compliance(): Promise<ComplianceSettings> {
        const { rows } = await this.query<ComplianceSettings & { confirmedAt: Date | null; updatedAt: Date }>(
            `SELECT c.state, c.security_deposit_max_months AS "securityDepositMaxMonths", c.deposit_interest_required AS "depositInterestRequired",
                    c.late_fee_grace_days AS "lateFeeGraceDays", c.late_fee_max_percent AS "lateFeeMaxPercent",
                    c.notice_to_quit_days AS "noticeToQuitDays", c.rent_increase_notice_days AS "rentIncreaseNoticeDays",
                    c.lead_paint_disclosure_required AS "leadPaintDisclosureRequired", c.notes, c."references",
                    c.confirmed_at AS "confirmedAt", ca.name AS "confirmedBy", c.updated_at AS "updatedAt", ua.name AS "updatedBy"
             FROM Compliance_Settings c LEFT JOIN Admin ca ON ca.admin_id = c.confirmed_by LEFT JOIN Admin ua ON ua.admin_id = c.updated_by`,
        )
        const row = rows[0]
        if (!row) throw new AppError("NOT_FOUND")
        return { ...row, confirmedAt: iso(row.confirmedAt), updatedAt: row.updatedAt.toISOString() }
    }

    async saveCompliance(input: ComplianceInput, confirm: boolean): Promise<void> {
        try {
            await this.query(
                `UPDATE Compliance_Settings SET state = $1, security_deposit_max_months = $2, deposit_interest_required = $3,
                     late_fee_grace_days = $4, late_fee_max_percent = $5, notice_to_quit_days = $6, rent_increase_notice_days = $7,
                     lead_paint_disclosure_required = $8, notes = $9, "references" = $10,
                     updated_at = now(), updated_by = NULLIF(current_setting('app.user_id', true), '')::int,
                     confirmed_at = CASE WHEN $11 THEN now() ELSE confirmed_at END,
                     confirmed_by = CASE WHEN $11 THEN NULLIF(current_setting('app.user_id', true), '')::int ELSE confirmed_by END`,
                [input.state, input.securityDepositMaxMonths, input.depositInterestRequired, input.lateFeeGraceDays, input.lateFeeMaxPercent,
                    input.noticeToQuitDays, input.rentIncreaseNoticeDays, input.leadPaintDisclosureRequired, input.notes, input.references, confirm],
            )
        } catch (error) {
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }

    /** Deposits charged on each current lease. */
    async listCurrentDeposits(today: string): Promise<DepositRow[]> {
        const { rows } = await this.query<DepositRow>(
            `SELECT l.LeaseID AS "leaseId", u.uID AS "unitId", ${UNIT_LABEL} AS "unitLabel", l.monthly_rent AS "monthlyRent",
                    COALESCE((SELECT sum(c.amount) FROM Charge c WHERE c.LeaseID = l.LeaseID AND c.kind = 'deposit'), 0) AS deposits
             FROM Lease l JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
             WHERE l.start_date <= $1::date AND (l.end_date IS NULL OR l.end_date >= $1::date) AND u.deactivated_at IS NULL
             ORDER BY p.Name, u.UnitNum`,
            [today],
        )
        return rows
    }

    /** Each active late fee rule, with the lowest rent among the leased units it applies to. */
    async listLateFeeRulesForCompliance(today: string): Promise<Array<{ ruleId: number; unitId: number | null; propertyId: number | null; label: string; graceDays: number; firstAmount: number; firstType: string; dailyAmount: number; dailyType: string; maxAmount: number | null; maxType: string; lowestRent: number | null }>> {
        const { rows } = await this.query<{ ruleId: number; unitId: number | null; propertyId: number | null; label: string; graceDays: number; firstAmount: number; firstType: string; dailyAmount: number; dailyType: string; maxAmount: number | null; maxType: string; lowestRent: number | null }>(
            `SELECT r.ruleID AS "ruleId", r.uID AS "unitId", r.pID AS "propertyId",
                    CASE WHEN r.uID IS NOT NULL THEN (SELECT 'Unit ' || u.UnitNum || ' - ' || p.Name FROM Units u JOIN Property p ON p.pID = u.pID WHERE u.uID = r.uID)
                         WHEN r.pID IS NOT NULL THEN (SELECT p.Name FROM Property p WHERE p.pID = r.pID)
                         ELSE 'All properties' END AS label,
                    r.grace_days AS "graceDays", r.first_amount AS "firstAmount", r.first_type AS "firstType",
                    r.daily_amount AS "dailyAmount", r.daily_type AS "dailyType", r.max_amount AS "maxAmount", r.max_type AS "maxType",
                    (SELECT min(l.monthly_rent) FROM Units u JOIN Lease l ON l.uID = u.uID
                     WHERE u.deactivated_at IS NULL AND l.start_date <= $1::date AND (l.end_date IS NULL OR l.end_date >= $1::date)
                       AND (SELECT x.ruleID FROM late_fee_rule_for(u.uID) x) = r.ruleID) AS "lowestRent"
             FROM Late_Fee_Rules r WHERE r.deactivated_at IS NULL ORDER BY r.ruleID`,
            [today],
        )
        return rows
    }

    /* ============================================================= Reports */

    async rentRollRows(today: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT f.name::text AS portfolio, p.Name AS property, u.UnitNum AS unit, ${RESIDENTS("x.lease_id")} AS residents,
                    l.monthly_rent AS rent, l.start_date AS "start", l.end_date AS "end", COALESCE(b.balance, 0) AS balance,
                    CASE WHEN x.lease_id IS NULL THEN 'vacant' WHEN COALESCE(b.balance, 0) > 0 THEN 'owing' ELSE 'current' END AS status,
                    (SELECT count(*)::int FROM Maintenance_T m WHERE m.uID = u.uID AND m.deactivated_at IS NULL AND m.status NOT IN ('resolved', 'rejected')) AS "openRequests"
             FROM (SELECT u.uID, ${CURRENT_LEASE("u.uID")} AS lease_id FROM Units u WHERE u.deactivated_at IS NULL) x
             JOIN Units u ON u.uID = x.uID JOIN Property p ON p.pID = u.pID AND p.deactivated_at IS NULL
             LEFT JOIN Portfolios f ON f.portfolio_id = p.portfolio_id AND f.retired_at IS NULL
             LEFT JOIN Lease l ON l.LeaseID = x.lease_id LEFT JOIN lease_balance b ON b.LeaseID = x.lease_id
             ORDER BY p.Name, u.UnitNum`,
            [today],
        )
        return rows
    }

    async tenantRows(today: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT t.Name AS name, t.Email::text AS email, t.Phone AS phone, cur.label AS unit, t.signup_completed AS "signedUp",
                    COALESCE(cur.balance, 0) AS balance, COALESCE(d.insurance_status, 'not_required') AS insurance,
                    d.insurance_expires AS "insuranceExpires", d.emergency_contact_name AS "emergencyName", d.emergency_contact_phone AS "emergencyPhone"
             FROM Tenants t
             LEFT JOIN Tenant_Details d ON d.tID = t.tID
             LEFT JOIN LATERAL (
                 SELECT ${UNIT_LABEL} AS label, b.balance FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID
                 JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID LEFT JOIN lease_balance b ON b.LeaseID = l.LeaseID
                 WHERE lt.tID = t.tID AND l.start_date <= $1::date AND (l.end_date IS NULL OR l.end_date >= $1::date)
                 ORDER BY l.start_date DESC LIMIT 1) cur ON true
             WHERE t.deactivated_at IS NULL
             ORDER BY t.Name, t.tID`,
            [today],
        )
        return rows
    }

    async paymentRows(from: string, to: string, timeZone: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT to_char(py."timestamp" AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS at, p.Name AS property, u.UnitNum AS unit,
                    ${RESIDENTS("py.LeaseID")} AS residents, py.amount, py.direction AS type, py.status,
                    COALESCE((SELECT CASE rp.method WHEN 'cashapp' THEN 'Cash App' ELSE 'Zelle' END || ' (reported by tenant)' FROM Reported_Payments rp WHERE rp.payID = py.payID),
                             (SELECT pd.method FROM Payment_Details pd WHERE pd.payID = py.payID LIMIT 1), '') AS method,
                    py.transaction_id AS confirmation
             FROM Payment py JOIN Lease l ON l.LeaseID = py.LeaseID JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
             WHERE (py."timestamp" AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
             ORDER BY py."timestamp", py.payID`,
            [from, to, timeZone],
        )
        return rows
    }

    async chargeRows(from: string, to: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT c.due_date AS due, p.Name AS property, u.UnitNum AS unit, ${RESIDENTS("c.LeaseID")} AS residents, c.kind, c.description, c.amount
             FROM Charge c JOIN Lease l ON l.LeaseID = c.LeaseID JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
             WHERE c.due_date BETWEEN $1::date AND $2::date
             ORDER BY c.due_date, p.Name, u.UnitNum, c.chargeID`,
            [from, to],
        )
        return rows
    }

    async expenseRows(from: string, to: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT e.spent_on AS date, p.Name AS property, u.UnitNum AS unit, e.category, e.vendor, e.description, e.amount
             FROM Expenses e LEFT JOIN Property p ON p.pID = e.pID LEFT JOIN Units u ON u.uID = e.uID
             WHERE e.voided_at IS NULL AND e.spent_on BETWEEN $1::date AND $2::date
             ORDER BY e.spent_on, e.expID`,
            [from, to],
        )
        return rows
    }

    async maintenanceRows(from: string, to: string, timeZone: string): Promise<Array<Record<string, unknown>>> {
        const { rows } = await this.query(
            `SELECT m.mID AS id, (m.created_at AT TIME ZONE $3)::date AS opened, p.Name AS property, u.UnitNum AS unit, m.title,
                    m.request_type AS type, m.priority, m.status, (m.completed_at AT TIME ZONE $3)::date AS completed, a.name AS assigned,
                    m.labor_cost AS labor, m.materials_cost AS materials
             FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID LEFT JOIN Admin a ON a.admin_id = m.assigned_to
             WHERE m.deactivated_at IS NULL AND (m.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
             ORDER BY m.created_at, m.mID`,
            [from, to, timeZone],
        )
        return rows
    }

    async incomeByPropertyRows(year: number, timeZone: string): Promise<Array<{ property: string; collected: number; expenses: number }>> {
        const { rows } = await this.query<{ property: string; collected: number; expenses: number }>(
            `SELECT p.Name AS property,
                    COALESCE((SELECT sum(CASE WHEN py.direction = 'charge' THEN py.amount ELSE -py.amount END)
                              FROM Payment py JOIN Lease l ON l.LeaseID = py.LeaseID JOIN Units u ON u.uID = l.uID
                              WHERE u.pID = p.pID AND py.status = 'completed' AND extract(year FROM py."timestamp" AT TIME ZONE $2) = $1), 0) AS collected,
                    COALESCE((SELECT sum(e.amount) FROM Expenses e WHERE e.pID = p.pID AND e.voided_at IS NULL AND extract(year FROM e.spent_on) = $1), 0) AS expenses
             FROM Property p WHERE p.deactivated_at IS NULL ORDER BY p.Name`,
            [year, timeZone],
        )
        return rows
    }

    /* ============================================================== Search */

    async search(q: string, digits: string, staffOnlyMaintenance: boolean): Promise<SearchHit[]> {
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        const hits: SearchHit[] = []
        const add = (rows: SearchHit[]) => hits.push(...rows)
        const base = { tenantId: null, unitId: null, leaseId: null }
        await this.tx(async (client) => {
            const run = async (sql: string, params: unknown[]) => (await client.query<SearchHit>(sql, params)).rows.map((r) => ({ ...base, ...r }))
            if (!staffOnlyMaintenance) {
                add(await run(
                    `SELECT 'tenant' AS kind, t.tID AS id, t.Name AS title,
                            concat_ws(' · ', t.Email::text, t.Phone,
                                (SELECT ${UNIT_LABEL} FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID JOIN Units u ON u.uID = l.uID
                                 JOIN Property p ON p.pID = u.pID WHERE lt.tID = t.tID ORDER BY l.start_date DESC LIMIT 1)) AS detail
                     FROM Tenants t
                     WHERE t.deactivated_at IS NULL AND (t.Name ILIKE $1 OR t.Email::text ILIKE $1 OR (length($2) >= 3 AND regexp_replace(COALESCE(t.Phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
                     ORDER BY t.Name LIMIT 5`, [like, digits]))
                add(await run(
                    `SELECT 'unit' AS kind, u.uID AS id, ${UNIT_LABEL} AS title, NULL AS detail
                     FROM Units u JOIN Property p ON p.pID = u.pID
                     WHERE u.deactivated_at IS NULL AND p.deactivated_at IS NULL AND (u.UnitNum ILIKE $1 OR ('unit ' || u.UnitNum) ILIKE $1 OR (${UNIT_LABEL}) ILIKE $1)
                     ORDER BY p.Name, u.UnitNum LIMIT 5`, [like]))
                add(await run(
                    `SELECT 'property' AS kind, p.pID AS id, p.Name AS title, p.Address AS detail
                     FROM Property p WHERE p.deactivated_at IS NULL AND (p.Name ILIKE $1 OR p.Address ILIKE $1) ORDER BY p.Name LIMIT 5`, [like]))
                add(await run(
                    `SELECT 'portfolio' AS kind, f.portfolio_id AS id, f.name::text AS title, f.entity_name AS detail
                     FROM Portfolios f WHERE f.retired_at IS NULL AND (f.name::text ILIKE $1 OR f.entity_name ILIKE $1) ORDER BY f.name LIMIT 5`, [like]))
            }
            add(await run(
                `SELECT 'maintenance' AS kind, m.mID AS id, m.title, ${UNIT_LABEL} || ' · ' || replace(m.status, '_', ' ') AS detail, u.uID AS "unitId"
                 FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID
                 WHERE m.deactivated_at IS NULL AND (m.title ILIKE $1 OR m.description ILIKE $1 OR (${UNIT_LABEL}) ILIKE $1)
                 ORDER BY m.created_at DESC LIMIT 5`, [like]))
            if (!staffOnlyMaintenance) {
                add(await run(
                    `SELECT 'listing' AS kind, s.listingID AS id, s.title, ${UNIT_LABEL} || ' · ' || s.status AS detail, u.uID AS "unitId"
                     FROM Listings s JOIN Units u ON u.uID = s.uID JOIN Property p ON p.pID = u.pID
                     WHERE s.title ILIKE $1 OR s.description ILIKE $1 ORDER BY s.created_at DESC LIMIT 5`, [like]))
                add(await run(
                    `SELECT 'document' AS kind, d.docID AS id, d.title, concat_ws(' · ', d.filename, d.category) AS detail,
                            d.tID AS "tenantId", COALESCE(d.uID, (SELECT l.uID FROM Lease l WHERE l.LeaseID = d.LeaseID)) AS "unitId", d.LeaseID AS "leaseId"
                     FROM Documents d WHERE d.hidden_at IS NULL AND (d.title ILIKE $1 OR d.filename ILIKE $1) ORDER BY d.uploaded_at DESC LIMIT 5`, [like]))
                add(await run(
                    `SELECT 'payment' AS kind, py.payID AS id, py.transaction_id AS title,
                            to_char(py.amount, 'FM"$"999,999,990.00') || ' · ' || ${UNIT_LABEL} AS detail, py.LeaseID AS "leaseId", u.uID AS "unitId"
                     FROM Payment py JOIN Lease l ON l.LeaseID = py.LeaseID JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID
                     WHERE py.transaction_id ILIKE $1 ORDER BY py."timestamp" DESC LIMIT 5`, [like]))
            }
        })
        return hits
    }

    /* ================================================== Maintenance detail */

    async maintenanceDetail(id: number): Promise<MaintenanceDetail | null> {
        return this.tx(async (client) => {
            const { rows } = await client.query<MaintenanceDetail & { createdAt: Date; updatedAt: Date; completedAt: Date | null }>(
                `SELECT m.mID AS id, m.title, m.description, m.status, m.priority, m.request_type AS "requestType", m.scheduled_for AS "scheduledFor",
                        m.created_at AS "createdAt", m.updated_at AS "updatedAt", m.completed_at AS "completedAt",
                        u.uID AS "unitId", u.UnitNum AS "unitNum", p.pID AS "propertyId", p.Name AS "propertyName",
                        t.tID AS "tenantId", t.Name AS "tenantName", t.Phone AS "tenantPhone",
                        m.assigned_to AS "assignedTo", a.name AS "assignedName", m.labor_cost AS "laborCost", m.materials_cost AS "materialsCost",
                        m.expense_id AS "expenseId"
                 FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID
                 LEFT JOIN Tenants t ON t.tID = m.tID LEFT JOIN Admin a ON a.admin_id = m.assigned_to
                 WHERE m.mID = $1 AND m.deactivated_at IS NULL`,
                [id],
            )
            const row = rows[0]
            if (!row) return null
            const history = await client.query<{ from: string | null; to: string; at: Date }>(
                `SELECT old_status AS "from", new_status AS "to", changed_at AS at FROM Maintenance_Status_History WHERE mID = $1 ORDER BY changed_at, histID`,
                [id],
            )
            const notes = await client.query<MaintenanceNote & { createdAt: Date }>(
                `SELECT n.noteID AS id, n.body, a.name AS author, n.created_at AS "createdAt"
                 FROM Maintenance_Notes n LEFT JOIN Admin a ON a.admin_id = n.admin_id WHERE n.mID = $1 ORDER BY n.created_at, n.noteID`,
                [id],
            )
            const attachments = await client.query<MaintenanceAttachment & { uploadedAt: Date }>(
                `SELECT x.attID AS id, x.filename, x.size_bytes AS "sizeBytes", COALESCE(a.name, t.Name) AS "uploadedBy",
                        (x.tID IS NOT NULL) AS "fromTenant", x.uploaded_at AS "uploadedAt"
                 FROM Maintenance_Attachments x LEFT JOIN Admin a ON a.admin_id = x.admin_id LEFT JOIN Tenants t ON t.tID = x.tID
                 WHERE x.mID = $1 ORDER BY x.uploaded_at, x.attID`,
                [id],
            )
            const assignees = await client.query<{ id: number; name: string; role: StaffRole }>(
                "SELECT admin_id AS id, name, role FROM Admin WHERE deactivated_at IS NULL AND signup_completed ORDER BY (role <> 'maintenance_staff'), name",
            )
            return {
                ...row,
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
                completedAt: iso(row.completedAt),
                history: history.rows.map((h) => ({ ...h, at: h.at.toISOString() })),
                notes: notes.rows.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
                attachments: attachments.rows.map((x) => ({ ...x, uploadedAt: x.uploadedAt.toISOString() })),
                assignees: assignees.rows,
            }
        })
    }

    async maintenanceForSummary(since: string): Promise<Array<{ status: string; priority: string; requestType: string; createdAt: Date; completedAt: Date | null; open: boolean; recent: boolean }>> {
        const { rows } = await this.query<{ status: string; priority: string; requestType: string; createdAt: Date; completedAt: Date | null; open: boolean; recent: boolean }>(
            `SELECT status, priority, request_type AS "requestType", created_at AS "createdAt", completed_at AS "completedAt",
                    status NOT IN ('resolved', 'rejected') AS open, created_at >= $1::timestamptz AS recent
             FROM Maintenance_T WHERE deactivated_at IS NULL`,
            [since],
        )
        return rows
    }

    async updateMaintenanceWork(id: number, input: MaintenanceWorkInput): Promise<void> {
        await this.tx(async (client) => {
            if (input.assignedTo !== undefined && input.assignedTo !== null) {
                const staff = await client.query("SELECT 1 FROM Admin WHERE admin_id = $1 AND deactivated_at IS NULL AND signup_completed", [input.assignedTo])
                if (!staff.rowCount) throw new AppError("VALIDATION_ERROR")
            }
            const sets: string[] = []
            const params: unknown[] = [id]
            const set = (column: string, value: unknown) => {
                params.push(value)
                sets.push(`${column} = $${params.length}`)
            }
            if (input.assignedTo !== undefined) set("assigned_to", input.assignedTo)
            if (input.laborCost !== undefined) set("labor_cost", input.laborCost)
            if (input.materialsCost !== undefined) set("materials_cost", input.materialsCost)
            if (sets.length === 0) return
            const result = await client.query(`UPDATE Maintenance_T SET ${sets.join(", ")}, updated_at = now() WHERE mID = $1 AND deactivated_at IS NULL`, params)
            if (!result.rowCount) throw new AppError("NOT_FOUND")
        })
    }

    async addMaintenanceNote(id: number, body: string): Promise<number> {
        try {
            const { rows } = await this.query<{ id: number }>(
                `INSERT INTO Maintenance_Notes (mID, body)
                 SELECT mID, $2 FROM Maintenance_T WHERE mID = $1 AND deactivated_at IS NULL RETURNING noteID AS id`,
                [id, body],
            )
            if (!rows[0]) throw new AppError("NOT_FOUND")
            return rows[0].id
        } catch (error) {
            if (hasCode(error, PG.privilege)) throw new AppError("FORBIDDEN")
            throw error
        }
    }

    /** Staff photo (admin_id from the request), or the resident's own (tID). */
    async addMaintenancePhoto(id: number, file: UploadedFile, by: { adminId: number } | { tenantId: number }): Promise<number> {
        try {
            const { rows } = await this.query<{ id: number }>(
                `INSERT INTO Maintenance_Attachments (mID, filename, content_type, size_bytes, sha256_hex, data, admin_id, tID)
                 SELECT mID, $2, $3, $4, $5, $6, $7, $8 FROM Maintenance_T WHERE mID = $1 AND deactivated_at IS NULL RETURNING attID AS id`,
                [id, file.filename, file.contentType, file.data.length, file.sha256, file.data,
                    "adminId" in by ? by.adminId : null, "tenantId" in by ? by.tenantId : null],
            )
            if (!rows[0]) throw new AppError("NOT_FOUND")
            return rows[0].id
        } catch (error) {
            // A tenant adding to someone else's (or a closed) request: the policy refuses it.
            if (hasCode(error, PG.privilege)) throw new AppError("NOT_FOUND")
            throw error
        }
    }

    async maintenancePhoto(id: number, attachmentId: number): Promise<StoredFile | null> {
        const { rows } = await this.query<StoredFile>(
            `SELECT filename, content_type AS "contentType", data FROM Maintenance_Attachments WHERE mID = $1 AND attID = $2`,
            [id, attachmentId],
        )
        return rows[0] ?? null
    }

    async tenantPhotos(ids: number[]): Promise<Record<string, TenantPhoto[]>> {
        const { rows } = await this.query<{ mid: number; id: number; filename: string }>(
            "SELECT mID AS mid, attID AS id, filename FROM Maintenance_Attachments WHERE mID = ANY($1::int[]) ORDER BY uploaded_at, attID",
            [ids],
        )
        const out: Record<string, TenantPhoto[]> = {}
        for (const r of rows) (out[String(r.mid)] ??= []).push({ id: r.id, filename: r.filename, href: `/api/tenant/maintenance/${r.mid}/attachments/${r.id}` })
        return out
    }

    /** Books labor + materials as one repairs expense, once. */
    async recordMaintenanceExpense(id: number, today: string): Promise<number> {
        return this.tx(async (client) => {
            const { rows } = await client.query<{ pid: number; uid: number; title: string; labor: number | null; materials: number | null; expense: number | null; done: string | null }>(
                `SELECT u.pID AS pid, m.uID AS uid, m.title, m.labor_cost AS labor, m.materials_cost AS materials, m.expense_id AS expense,
                        (m.completed_at AT TIME ZONE COALESCE(p.time_zone, 'America/Denver'))::date::text AS done
                 FROM Maintenance_T m JOIN Units u ON u.uID = m.uID JOIN Property p ON p.pID = u.pID
                 WHERE m.mID = $1 AND m.deactivated_at IS NULL FOR UPDATE OF m`,
                [id],
            )
            const row = rows[0]
            if (!row) throw new AppError("NOT_FOUND")
            if (row.expense !== null) throw new AppError("ALREADY_RECORDED")
            const total = Math.round(((row.labor ?? 0) + (row.materials ?? 0)) * 100) / 100
            if (total <= 0) throw new AppError("VALIDATION_ERROR")
            const spent = row.done && row.done <= today ? row.done : today
            const expense = await client.query<{ id: number }>(
                `INSERT INTO Expenses (pID, uID, category, amount, spent_on, description, created_by)
                 VALUES ($1, $2, 'repairs', $3, $4, $5, NULLIF(current_setting('app.user_id', true), '')::int) RETURNING expID AS id`,
                [row.pid, row.uid, total, spent, `Maintenance #${id}: ${row.title}`.slice(0, 300)],
            )
            await client.query("UPDATE Maintenance_T SET expense_id = $2, updated_at = now() WHERE mID = $1", [id, expense.rows[0]!.id])
            return expense.rows[0]!.id
        })
    }

    /* =========================================================== Documents */

    private static readonly HUB = `
        WITH docs AS (
            SELECT d.docID AS id, 'document' AS kind, d.scope, COALESCE(d.pID, d.uID, d.tID, d.LeaseID) AS "scopeId", d.category, d.title,
                   d.filename, d.content_type AS "contentType", d.size_bytes AS "sizeBytes", d.shared_with_tenant AS "sharedWithTenant",
                   d.uploaded_at AS "uploadedAt", a.name AS "uploadedBy",
                   COALESCE(d.pID, du.pID, lu.pID) AS "propertyId", COALESCE(d.uID, l.uID) AS "unitId", d.tID AS "tenantId", d.LeaseID AS "leaseId",
                   '/api/manager/documents/' || d.docID AS href
            FROM Documents d
            LEFT JOIN Units du ON du.uID = d.uID LEFT JOIN Lease l ON l.LeaseID = d.LeaseID LEFT JOIN Units lu ON lu.uID = l.uID
            LEFT JOIN Admin a ON a.admin_id = d.uploaded_by
            WHERE d.hidden_at IS NULL
            UNION ALL
            SELECT ld.LeaseID, 'lease_pdf', 'lease', ld.LeaseID, 'lease', 'Signed lease', ld.filename, ld.content_type, ld.size_bytes, true,
                   ld.uploaded_at, a.name, u.pID, u.uID, NULL, ld.LeaseID, '/api/manager/leases/' || ld.LeaseID || '/document'
            FROM Lease_Documents ld JOIN Lease l ON l.LeaseID = ld.LeaseID JOIN Units u ON u.uID = l.uID LEFT JOIN Admin a ON a.admin_id = ld.uploaded_by
            UNION ALL
            SELECT r.payID, 'receipt', 'lease', py.LeaseID, 'receipt', 'Payment receipt', r.filename, r.content_type, r.size_bytes, false,
                   r.uploaded_at, NULL, u.pID, u.uID, NULL, py.LeaseID, '/api/manager/leases/' || py.LeaseID || '/payments/' || r.payID || '/receipt'
            FROM Payment_Receipts r JOIN Payment py ON py.payID = r.payID JOIN Lease l ON l.LeaseID = py.LeaseID JOIN Units u ON u.uID = l.uID
        )
        SELECT docs.*, p.Name AS "propertyName", u.UnitNum AS "unitNum", t.Name AS "tenantName"
        FROM docs LEFT JOIN Property p ON p.pID = docs."propertyId" LEFT JOIN Units u ON u.uID = docs."unitId" LEFT JOIN Tenants t ON t.tID = docs."tenantId"`

    async listHubDocuments(filter: HubFilter): Promise<HubDocument[]> {
        const like = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
        const { rows } = await this.query<HubDocument & { uploadedAt: Date }>(
            `SELECT * FROM (${PostgresAdditions.HUB}) x
             WHERE ($1::text IS NULL OR x.category = $1)
               AND ($2::text IS NULL OR x.title ILIKE $2 OR x.filename ILIKE $2 OR x."propertyName" ILIKE $2 OR x."tenantName" ILIKE $2)
               AND ($3::text IS NULL OR CASE $3
                     WHEN 'property' THEN x."propertyId" = $4
                         OR x."tenantId" IN (SELECT lt.tID FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID JOIN Units u ON u.uID = l.uID WHERE u.pID = $4)
                     WHEN 'unit' THEN x."unitId" = $4
                         OR x."tenantId" IN (SELECT lt.tID FROM Lease_Tenants lt JOIN Lease l ON l.LeaseID = lt.LeaseID WHERE l.uID = $4)
                     WHEN 'tenant' THEN x."tenantId" = $4 OR x."leaseId" IN (SELECT lt.LeaseID FROM Lease_Tenants lt WHERE lt.tID = $4)
                     WHEN 'lease' THEN x."leaseId" = $4
                     ELSE false END)
             ORDER BY x."uploadedAt" DESC, x.id DESC`,
            [filter.category, like, filter.scope, filter.id],
        )
        return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }))
    }

    async addDocument(input: NewDocument): Promise<number> {
        const column = { property: "pID", unit: "uID", tenant: "tID", lease: "LeaseID" }[input.scope]
        const table = { property: "Property WHERE pID = $1 AND deactivated_at IS NULL", unit: "Units WHERE uID = $1 AND deactivated_at IS NULL",
            tenant: "Tenants WHERE tID = $1 AND deactivated_at IS NULL", lease: "Lease WHERE LeaseID = $1" }[input.scope]
        return this.tx(async (client) => {
            const exists = await client.query(`SELECT 1 FROM ${table}`, [input.scopeId])
            if (!exists.rowCount) throw new AppError("NOT_FOUND")
            const { rows } = await client.query<{ id: number }>(
                `INSERT INTO Documents (scope, ${column}, category, title, filename, content_type, size_bytes, sha256_hex, data, shared_with_tenant, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULLIF(current_setting('app.user_id', true), '')::int) RETURNING docID AS id`,
                [input.scope, input.scopeId, input.category, input.title, input.file.filename, input.file.contentType, input.file.data.length,
                    input.file.sha256, input.file.data, input.sharedWithTenant],
            )
            return rows[0]!.id
        })
    }

    async updateDocument(id: number, change: DocumentChange): Promise<void> {
        const result = await this.query(
            `UPDATE Documents SET title = COALESCE($2, title), category = COALESCE($3, category), shared_with_tenant = COALESCE($4, shared_with_tenant)
             WHERE docID = $1 AND hidden_at IS NULL`,
            [id, change.title ?? null, change.category ?? null, change.sharedWithTenant ?? null],
        )
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    async hideDocument(id: number): Promise<void> {
        const result = await this.query("UPDATE Documents SET hidden_at = now() WHERE docID = $1 AND hidden_at IS NULL", [id])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /** Staff see any visible document; a tenant only what RLS shares with them. */
    async documentFile(id: number): Promise<StoredFile | null> {
        const { rows } = await this.query<StoredFile>(
            `SELECT filename, content_type AS "contentType", data FROM Documents WHERE docID = $1 AND hidden_at IS NULL`,
            [id],
        )
        return rows[0] ?? null
    }

    async tenantDocuments(): Promise<Array<TenantDocument & { category: string }>> {
        const { rows } = await this.query<TenantDocument & { category: string; uploadedAt: Date }>(
            `SELECT docID AS id, 'document' AS kind, category, title, filename, uploaded_at AS "uploadedAt", '/api/tenant/documents/' || docID AS href
             FROM Documents WHERE hidden_at IS NULL ORDER BY uploaded_at DESC, docID DESC`,
        )
        return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }))
    }

    /* ============================================================= Notices */

    async listNotices(filter: NoticeFilter): Promise<NoticeRow[]> {
        const like = filter.q ? `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
        const { rows } = await this.query<NoticeRow & { createdAt: Date; sentAt: Date | null; readAt: Date | null }>(
            `SELECT n.notID AS id, n.tID AS "tenantId", t.Name AS "tenantName",
                    (SELECT ${UNIT_LABEL} FROM Lease l JOIN Units u ON u.uID = l.uID JOIN Property p ON p.pID = u.pID WHERE l.LeaseID = n.LeaseID) AS "unitLabel",
                    n.channel, n.template, n.subject, n.body, n.status, n.error, n.created_at AS "createdAt", a.name AS "createdBy",
                    n.sent_at AS "sentAt", n.read_at AS "readAt"
             FROM Notifications_Sent n JOIN Tenants t ON t.tID = n.tID LEFT JOIN Admin a ON a.admin_id = n.created_by
             WHERE ($1::text IS NULL OR n.template = $1) AND ($2::text IS NULL OR n.channel = $2) AND ($3::text IS NULL OR n.status = $3)
               AND ($4::text IS NULL OR n.subject ILIKE $4 OR n.body ILIKE $4 OR t.Name ILIKE $4)
             ORDER BY n.created_at DESC, n.notID DESC
             LIMIT 500`,
            [filter.template, filter.channel, filter.status, like],
        )
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), sentAt: iso(r.sentAt), readAt: iso(r.readAt) }))
    }

    /** One in-app notice per resident on a current lease in the audience. Returns how many. */
    async sendNotice(audience: NoticeAudience, subject: string, body: string, today: string): Promise<number> {
        return this.tx(async (client) => {
            const { rowCount } = await client.query(
                `INSERT INTO Notifications_Sent (tID, LeaseID, channel, template, subject, body, status, created_by, sent_at)
                 SELECT DISTINCT ON (lt.tID) lt.tID, l.LeaseID, 'in_app', 'manual', $4, $5, 'sent', NULLIF(current_setting('app.user_id', true), '')::int, now()
                 FROM Lease l JOIN Lease_Tenants lt ON lt.LeaseID = l.LeaseID JOIN Tenants t ON t.tID = lt.tID JOIN Units u ON u.uID = l.uID
                 WHERE l.start_date <= $1::date AND (l.end_date IS NULL OR l.end_date >= $1::date) AND t.deactivated_at IS NULL
                   AND CASE $2 WHEN 'property' THEN u.pID = $3 WHEN 'tenant' THEN lt.tID = $3 ELSE true END
                 ORDER BY lt.tID, l.start_date DESC`,
                [today, audience.kind, "id" in audience ? audience.id : null, subject, body],
            )
            if (!rowCount) throw new AppError("NO_RECIPIENTS")
            return rowCount
        })
    }

    /** Notices the office wrote to this tenant (automatic ones show on the tenant's Notices page already). */
    async tenantNotices(): Promise<TenantNotice[]> {
        const { rows } = await this.query<TenantNotice & { createdAt: Date; readAt: Date | null }>(
            `SELECT notID AS id, template, subject, body, created_at AS "createdAt", read_at AS "readAt"
             FROM Notifications_Sent WHERE template = 'manual' AND channel = 'in_app' AND tID = app_tenant_id()
             ORDER BY created_at DESC, notID DESC LIMIT 100`,
        )
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), readAt: iso(r.readAt) }))
    }

    async markNoticeRead(id: number): Promise<void> {
        const result = await this.query("UPDATE Notifications_Sent SET read_at = COALESCE(read_at, now()) WHERE notID = $1 AND tID = app_tenant_id()", [id])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /* ======================================================== Listings, leads */

    private static readonly LISTING = `
        SELECT s.listingID AS id, s.uID AS "unitId", s.status, s.title, s.description, s.asking_rent AS "askingRent", s.available_on AS "availableOn",
               s.beds, s.baths, s.sqft, s.amenities, s.pets, u.UnitNum AS "unitNum", p.pID AS "propertyId", p.Name AS "propertyName", p.Address AS address,
               (${CURRENT_LEASE("u.uID", "current_date")} IS NOT NULL) AS occupied,
               s.created_at AS "createdAt", a.name AS "createdBy", s.published_at AS "publishedAt", s.ended_at AS "endedAt",
               'not_connected' AS "zillowStatus",
               (SELECT count(*)::int FROM Leads d WHERE d.listingID = s.listingID) AS leads,
               (SELECT count(*)::int FROM Leads d WHERE d.listingID = s.listingID AND d.status = 'new') AS "newLeads",
               (SELECT count(*)::int FROM Property_Images i WHERE i.deactivated_at IS NULL AND (i.uID = u.uID OR i.pID = u.pID)) AS photos
        FROM Listings s JOIN Units u ON u.uID = s.uID JOIN Property p ON p.pID = u.pID LEFT JOIN Admin a ON a.admin_id = s.created_by`

    private static listing(r: ListingRow & { createdAt: Date; publishedAt: Date | null; endedAt: Date | null }): ListingRow {
        return { ...r, createdAt: r.createdAt.toISOString(), publishedAt: iso(r.publishedAt), endedAt: iso(r.endedAt) }
    }

    async listListings(): Promise<ListingRow[]> {
        const { rows } = await this.query<ListingRow & { createdAt: Date; publishedAt: Date | null; endedAt: Date | null }>(
            `${PostgresAdditions.LISTING} ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, s.created_at DESC`,
        )
        return rows.map(PostgresAdditions.listing)
    }

    async findListing(id: number): Promise<ListingRow | null> {
        const { rows } = await this.query<ListingRow & { createdAt: Date; publishedAt: Date | null; endedAt: Date | null }>(`${PostgresAdditions.LISTING} WHERE s.listingID = $1`, [id])
        return rows[0] ? PostgresAdditions.listing(rows[0]) : null
    }

    async createListing(unitId: number, input: ListingInput): Promise<number> {
        try {
            return await this.tx(async (client) => {
                const unit = await client.query("SELECT 1 FROM Units u JOIN Property p ON p.pID = u.pID WHERE u.uID = $1 AND u.deactivated_at IS NULL AND p.deactivated_at IS NULL", [unitId])
                if (!unit.rowCount) throw new AppError("NOT_FOUND")
                const { rows } = await client.query<{ id: number }>(
                    `INSERT INTO Listings (uID, title, description, asking_rent, available_on, beds, baths, sqft, amenities, pets, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULLIF(current_setting('app.user_id', true), '')::int) RETURNING listingID AS id`,
                    [unitId, input.title, input.description, input.askingRent, input.availableOn, input.beds, input.baths, input.sqft, input.amenities, input.pets],
                )
                return rows[0]!.id
            })
        } catch (error) {
            if (hasCode(error, PG.unique)) throw new AppError("LISTING_EXISTS")
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }

    async updateListing(id: number, input: ListingInput): Promise<void> {
        try {
            const result = await this.query(
                `UPDATE Listings SET title = $2, description = $3, asking_rent = $4, available_on = $5, beds = $6, baths = $7, sqft = $8, amenities = $9, pets = $10
                 WHERE listingID = $1 AND status <> 'ended'`,
                [id, input.title, input.description, input.askingRent, input.availableOn, input.beds, input.baths, input.sqft, input.amenities, input.pets],
            )
            if (!result.rowCount) throw new AppError(await this.listingExists(id) ? "LISTING_NOT_EDITABLE" : "NOT_FOUND")
        } catch (error) {
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }

    private async listingExists(id: number) {
        return ((await this.query("SELECT 1 FROM Listings WHERE listingID = $1", [id])).rowCount ?? 0) > 0
    }

    async setListingStatus(id: number, to: "active" | "ended"): Promise<void> {
        const sql = to === "active"
            ? "UPDATE Listings SET status = 'active', published_at = now() WHERE listingID = $1 AND status = 'draft'"
            : "UPDATE Listings SET status = 'ended', ended_at = now() WHERE listingID = $1 AND status <> 'ended'"
        const result = await this.query(sql, [id])
        if (!result.rowCount) throw new AppError(await this.listingExists(id) ? "LISTING_NOT_EDITABLE" : "NOT_FOUND")
    }

    async removeDraftListing(id: number): Promise<void> {
        try {
            const result = await this.query("DELETE FROM Listings WHERE listingID = $1 AND status = 'draft'", [id])
            if (!result.rowCount) throw new AppError(await this.listingExists(id) ? "LISTING_NOT_EDITABLE" : "NOT_FOUND")
        } catch (error) {
            // It already has leads: end it instead, so they stay on record.
            if (hasCode(error, PG.foreignKey)) throw new AppError("LISTING_NOT_EDITABLE")
            throw error
        }
    }

    async listLeads(listingId: number | null = null): Promise<LeadRow[]> {
        const { rows } = await this.query<LeadRow & { createdAt: Date }>(
            `SELECT leadID AS id, listingID AS "listingId", name, email::text AS email, phone, message, source, status, created_at AS "createdAt"
             FROM Leads WHERE ($1::int IS NULL OR listingID = $1) ORDER BY created_at DESC, leadID DESC`,
            [listingId],
        )
        return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
    }

    async addLead(listingId: number, input: LeadInput): Promise<number> {
        try {
            const { rows } = await this.query<{ id: number }>(
                `INSERT INTO Leads (listingID, name, email, phone, message, source)
                 SELECT listingID, $2, $3, $4, $5, 'manual' FROM Listings WHERE listingID = $1 RETURNING leadID AS id`,
                [listingId, input.name, input.email, input.phone, input.message],
            )
            if (!rows[0]) throw new AppError("NOT_FOUND")
            return rows[0].id
        } catch (error) {
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }

    async setLeadStatus(id: number, status: LeadStatus): Promise<void> {
        const result = await this.query("UPDATE Leads SET status = $2 WHERE leadID = $1", [id, status])
        if (!result.rowCount) throw new AppError("NOT_FOUND")
    }

    /* ---- The public page (no sign-in: SECURITY DEFINER functions only) ---- */

    async publicListings(): Promise<PublicListing[]> {
        const { rows } = await this.query<PublicListing>(
            `SELECT id, title, description, asking_rent AS "askingRent", available_on AS "availableOn", beds, baths, sqft, amenities, pets, city,
                    photo_ids AS "photoIds" FROM public_listings()`,
        )
        return rows
    }

    async publicListingPhoto(listingId: number, imageId: number): Promise<{ contentType: string; data: Buffer } | null> {
        const { rows } = await this.query<{ contentType: string; data: Buffer }>(
            `SELECT content_type AS "contentType", data FROM public_listing_photo($1, $2)`,
            [listingId, imageId],
        )
        return rows[0] ?? null
    }

    /** Null when the listing is not listed (any more). */
    async publicInquire(listingId: number, input: LeadInput): Promise<number | null> {
        try {
            const { rows } = await this.query<{ id: number | null }>(
                "SELECT public_inquire($1, $2, $3, $4, $5) AS id",
                [listingId, input.name, input.email, input.phone, input.message],
            )
            return rows[0]?.id ?? null
        } catch (error) {
            if (hasCode(error, PG.check)) throw new AppError("VALIDATION_ERROR")
            throw error
        }
    }
}
