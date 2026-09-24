import crypto from "crypto"
import type { DatabaseInterface, RefreshTokenRecord, Role, UserRecord } from "../types/interfaces"

export class MemoryDatabase implements DatabaseInterface {
    private readonly users = new Map<string, UserRecord>()
    private readonly refreshTokens = new Map<string, RefreshTokenRecord>()

    async createUser(data: { email: string; password_h: string; role: Role }): Promise<UserRecord> {
        const user: UserRecord = { id: crypto.randomUUID(), ...data, createdAt: new Date() }
        this.users.set(user.id, user)
        return user
    }

    async findUserByEmail(email: string): Promise<UserRecord | null> {
        return [...this.users.values()].find((user) => user.email === email) ?? null
    }

    async findUserByID(id: string): Promise<UserRecord | null> {
        return this.users.get(id) ?? null
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