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

export interface UserRepository {
    createUser(data: {email: string, password_h: string, role: Role}): Promise<UserRecord>
    findUserByEmail(email: string): Promise<UserRecord | null>
    findUserByID(id: string): Promise<UserRecord | null>
}

export interface SessionRepository {
    storeRefreshToken(data: {user_id: string, token_h: string, expiresAt: Date }): Promise<RefreshTokenRecord>
    findRefreshTokenByHash(token_h: string): Promise<RefreshTokenRecord | null>
    revokeRefreshToken(token_h: string): Promise<void>
    revokeAllTokensForUser(user_id: string): Promise<void>
}

export type AuthStore = UserRepository & SessionRepository

export interface DatabaseInterface extends AuthStore {}