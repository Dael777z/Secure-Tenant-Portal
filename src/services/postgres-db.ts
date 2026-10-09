import type { Pool } from "pg"
import type { DatabaseInterface, InvitedTenant, RefreshTokenRecord, Role, UserRecord } from "../types/interfaces"

/**
 * DatabaseInterface on Angel's schema (db/migrations).
 *
 * Tenants and staff live in two tables (Tenants, Admin), each with its own
 * SERIAL id, so tenant 5 and admin 5 are different people. The id the rest of
 * the backend sees, and that goes in the JWT, says which table it is:
 * "tenant:5" or "admin:5".
 */

type Owner = { table: "tenant"; id: number } | { table: "admin"; id: number }

export function parseUserId(id: string): Owner | null {
    const match = /^(tenant|admin):([1-9][0-9]{0,9})$/.exec(id)
    if (!match) return null
    return { table: match[1] as "tenant" | "admin", id: Number(match[2]) }
}

const tenantId = (tID: number) => `tenant:${tID}`
const adminId = (adminID: number) => `admin:${adminID}`

interface TenantRow { tid: number; email: string; password_hash: string; created_at?: Date }
interface AdminRow { admin_id: number; email: string; password_hash: string; role: Exclude<Role, "tenant"> }
interface TokenRow { id: string; tid: number | null; admin_id: number | null; token_hash: string; expires_at: Date; revoked: boolean; created_at: Date }

const fromTenant = (row: TenantRow): UserRecord => ({
    id: tenantId(row.tid),
    email: row.email,
    password_h: row.password_hash,
    role: "tenant",
    createdAt: row.created_at ?? new Date(0),
})

const fromAdmin = (row: AdminRow): UserRecord => ({
    id: adminId(row.admin_id),
    email: row.email,
    password_h: row.password_hash,
    role: row.role,
    createdAt: new Date(0),
})

const fromToken = (row: TokenRow): RefreshTokenRecord => ({
    id: row.id,
    user_id: row.tid !== null ? tenantId(row.tid) : adminId(row.admin_id!),
    token_h: row.token_hash.trim(),
    expiresAt: row.expires_at,
    revoked: row.revoked,
    createdAt: row.created_at,
})

export class PostgresDatabase implements DatabaseInterface {
    constructor(private readonly pool: Pool) {}

    async createUser(data: { email: string; password_h: string; role: Role; name?: string }): Promise<UserRecord> {
        const name = data.name ?? data.email
        if (data.role === "tenant") {
            const { rows } = await this.pool.query<TenantRow>(
                `INSERT INTO Tenants (Name, Email, password_hash, signed_up)
                 VALUES ($1, $2, $3, true)
                 RETURNING tID AS tid, Email AS email, password_hash`,
                [name, data.email, data.password_h],
            )
            return fromTenant(rows[0]!)
        }
        const { rows } = await this.pool.query<AdminRow>(
            `INSERT INTO Admin (name, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING admin_id, email, password_hash, role`,
            [name, data.email, data.password_h, data.role],
        )
        return fromAdmin(rows[0]!)
    }

    async inviteTenant(data: { name: string; email: string; phone?: string | null }): Promise<InvitedTenant> {
        const { rows } = await this.pool.query<{ tid: number; name: string; email: string; phone: string | null }>(
            `INSERT INTO Tenants (Name, Phone, Email) VALUES ($1, $2, $3)
             RETURNING tID AS tid, Name AS name, Email AS email, Phone AS phone`,
            [data.name, data.phone ?? null, data.email.trim().toLowerCase()],
        )
        const row = rows[0]!
        return { id: tenantId(row.tid), name: row.name, email: row.email, phone: row.phone }
    }

    async completeSignup(email: string, password_h: string): Promise<UserRecord | null> {
        // One statement: two sign-ups racing for the same invitation cannot both win.
        const { rows } = await this.pool.query<TenantRow>(
            `UPDATE Tenants SET password_hash = $2, signed_up = true
             WHERE Email = $1 AND NOT signed_up
             RETURNING tID AS tid, Email AS email, password_hash`,
            [email, password_h],
        )
        return rows[0] ? fromTenant(rows[0]) : null
    }

    async findUserByEmail(email: string): Promise<UserRecord | null> {
        const admin = await this.pool.query<AdminRow>(
            "SELECT admin_id, email, password_hash, role FROM Admin WHERE email = $1",
            [email],
        )
        if (admin.rows[0]) return fromAdmin(admin.rows[0])
        const tenant = await this.pool.query<TenantRow>(
            "SELECT tID AS tid, Email AS email, password_hash FROM Tenants WHERE Email = $1 AND signed_up",
            [email],
        )
        return tenant.rows[0] ? fromTenant(tenant.rows[0]) : null
    }

    async findUserByID(id: string): Promise<UserRecord | null> {
        const owner = parseUserId(id)
        if (!owner) return null
        if (owner.table === "admin") {
            const { rows } = await this.pool.query<AdminRow>(
                "SELECT admin_id, email, password_hash, role FROM Admin WHERE admin_id = $1",
                [owner.id],
            )
            return rows[0] ? fromAdmin(rows[0]) : null
        }
        const { rows } = await this.pool.query<TenantRow>(
            "SELECT tID AS tid, Email AS email, password_hash FROM Tenants WHERE tID = $1 AND signed_up",
            [owner.id],
        )
        return rows[0] ? fromTenant(rows[0]) : null
    }

    async storeRefreshToken(data: { user_id: string; token_h: string; expiresAt: Date }): Promise<RefreshTokenRecord> {
        const owner = parseUserId(data.user_id)
        if (!owner) throw new Error(`not a user id: ${data.user_id}`)
        const { rows } = await this.pool.query<TokenRow>(
            `INSERT INTO Refresh_Tokens (tID, admin_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4)
             RETURNING id, tID AS tid, admin_id, token_hash, expires_at, revoked, created_at`,
            [
                owner.table === "tenant" ? owner.id : null,
                owner.table === "admin" ? owner.id : null,
                data.token_h,
                data.expiresAt,
            ],
        )
        return fromToken(rows[0]!)
    }

    async findRefreshTokenByHash(token_h: string): Promise<RefreshTokenRecord | null> {
        const { rows } = await this.pool.query<TokenRow>(
            `SELECT id, tID AS tid, admin_id, token_hash, expires_at, revoked, created_at
             FROM Refresh_Tokens WHERE token_hash = $1`,
            [token_h],
        )
        return rows[0] ? fromToken(rows[0]) : null
    }

    async revokeRefreshToken(token_h: string): Promise<void> {
        await this.pool.query("UPDATE Refresh_Tokens SET revoked = true WHERE token_hash = $1", [token_h])
    }

    async revokeAllTokensForUser(user_id: string): Promise<void> {
        const owner = parseUserId(user_id)
        if (!owner) return
        await this.pool.query(
            owner.table === "tenant"
                ? "UPDATE Refresh_Tokens SET revoked = true WHERE tID = $1 AND NOT revoked"
                : "UPDATE Refresh_Tokens SET revoked = true WHERE admin_id = $1 AND NOT revoked",
            [owner.id],
        )
    }
}
