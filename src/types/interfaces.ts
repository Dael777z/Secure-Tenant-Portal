import type { Request } from 'express'

export interface ValidRequest extends Request {
    user?: {id: string, role: Role}
}

export type Role = "platform_admin" | "property_manager" | "maintenance_staff" | "tenant"

export type Permission =
    | "system:health"
    | "ledger:read:self"
    | "ledger:read:property"
    | "ledger:adjust"
    | "payment:create:self"
    | "payment:review"
    | "maintenance:create"
    | "maintenance:manage"
    | "notifications:send"
    | "users:provision"

export interface UserRecord {
    id: string
    email: string
    password_h: string
    role: Role
    createdAt: Date
}

export interface RefreshTokenRecord {
    id: string
    user_id: string
    token_h: string
    expiresAt: Date
    revoked: boolean
    createdAt: Date
}

/** A tenant the office has added who has not signed up yet. */
export interface InvitedTenant {
    id: string
    name: string
    email: string
    phone: string | null
}

export interface UserRepository {
    /** Provision an account that can sign in right away (staff, or seeding). */
    createUser(data: {email: string, password_h: string, role: Role, name?: string}): Promise<UserRecord>
    /** Only accounts that can sign in: signed-up tenants and staff. */
    findUserByEmail(email: string): Promise<UserRecord | null>
    findUserByID(id: string): Promise<UserRecord | null>
    /**
     * The office adds a tenant before they can sign up (agreed 10/1). The
     * tenant has no password until they do.
     */
    inviteTenant(data: {name: string, email: string, phone?: string | null}): Promise<InvitedTenant>
    /**
     * Set the password for an invited tenant who has not signed up yet.
     * Null when there is no such invitation (never invited, or already signed up).
     */
    completeSignup(email: string, password_h: string): Promise<UserRecord | null>
}

export interface SessionRepository {
    storeRefreshToken(data: {user_id: string, token_h: string, expiresAt: Date }): Promise<RefreshTokenRecord>
    findRefreshTokenByHash(token_h: string): Promise<RefreshTokenRecord | null>
    revokeRefreshToken(token_h: string): Promise<void>
    revokeAllTokensForUser(user_id: string): Promise<void>
}

export type AuthStore = UserRepository & SessionRepository

export interface DatabaseInterface extends AuthStore {}