import crypto from "crypto"
import type { DatabaseInterface, InvitedTenant, RefreshTokenRecord, Role, UserRecord } from "../types/interfaces"

interface StoredUser {
    id: string
    email: string
    password_h: string | null
    role: Role
    name: string
    phone: string | null
    signedUp: boolean
    createdAt: Date
}

const toRecord = (user: StoredUser): UserRecord => ({
    id: user.id,
    email: user.email,
    password_h: user.password_h!,
    role: user.role,
    createdAt: user.createdAt,
})

/** In-memory stand-in for the Postgres adapter (DEV=1 without DATABASE_URL, and unit tests). */
export class MemoryDatabase implements DatabaseInterface {
    private readonly users = new Map<string, StoredUser>()
    private readonly refreshTokens = new Map<string, RefreshTokenRecord>()

    async createUser(data: { email: string; password_h: string; role: Role; name?: string }): Promise<UserRecord> {
        const user: StoredUser = {
            id: crypto.randomUUID(),
            email: data.email,
            password_h: data.password_h,
            role: data.role,
            name: data.name ?? data.email,
            phone: null,
            signedUp: true,
            createdAt: new Date(),
        }
        this.users.set(user.id, user)
        return toRecord(user)
    }

    async inviteTenant(data: { name: string; email: string; phone?: string | null }): Promise<InvitedTenant> {
        const email = data.email.trim().toLowerCase()
        if ([...this.users.values()].some((user) => user.email === email)) {
            throw new Error(`email ${email} already has an account`)
        }
        const user: StoredUser = {
            id: crypto.randomUUID(),
            email,
            password_h: null,
            role: "tenant",
            name: data.name,
            phone: data.phone ?? null,
            signedUp: false,
            createdAt: new Date(),
        }
        this.users.set(user.id, user)
        return { id: user.id, name: user.name, email: user.email, phone: user.phone }
    }

    async completeSignup(email: string, password_h: string): Promise<UserRecord | null> {
        const user = [...this.users.values()].find((u) => u.email === email && u.role === "tenant" && !u.signedUp)
        if (!user) return null
        user.password_h = password_h
        user.signedUp = true
        return toRecord(user)
    }

    async findUserByEmail(email: string): Promise<UserRecord | null> {
        const user = [...this.users.values()].find((u) => u.email === email && u.signedUp)
        return user ? toRecord(user) : null
    }

    async findUserByID(id: string): Promise<UserRecord | null> {
        const user = this.users.get(id)
        return user && user.signedUp ? toRecord(user) : null
    }

    async storeRefreshToken(data: { user_id: string; token_h: string; expiresAt: Date }): Promise<RefreshTokenRecord> {
        const token: RefreshTokenRecord = { id: crypto.randomUUID(), ...data, revoked: false, createdAt: new Date() }
        this.refreshTokens.set(token.token_h, token)
        return token
    }

    async findRefreshTokenByHash(token_h: string): Promise<RefreshTokenRecord | null> {
        return this.refreshTokens.get(token_h) ?? null
    }

    async revokeRefreshToken(token_h: string): Promise<void> {
        const token = this.refreshTokens.get(token_h)
        if (token) token.revoked = true
    }

    async revokeAllTokensForUser(user_id: string): Promise<void> {
        for (const token of this.refreshTokens.values()) {
            if (token.user_id === user_id) token.revoked = true
        }
    }
}
