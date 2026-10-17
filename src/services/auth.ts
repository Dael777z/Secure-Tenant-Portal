import bcrypt from "bcrypt"
import { randomBytes } from "node:crypto"

import type { Role } from "../types/access"
import { AppError } from "../types/errors"
import type { AuthStore } from "../types/stores"
import { generateAccessToken, hashToken, randomToken, type AccessTokenConfig } from "../utils/tokens"

export interface AuthConfig extends AccessTokenConfig {
    bcryptRounds: number
    refreshTtlMilliseconds: number
}

/**
 * Sign-up, sign-in and sessions. Only invited tenants can sign up: the token
 * from their link lets them choose a password, and every way a token can be
 * bad (unknown, used, expired, tenant deactivated) gets the same answer.
 */
export class AuthService {
    /** Compared against when the email is unknown, so that takes as long as a wrong password. */
    private readonly dummyHash: string

    constructor(private readonly db: AuthStore, private readonly config: AuthConfig) {
        this.dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), config.bcryptRounds)
    }

    async signup(inviteToken: string, password: string) {
        if (!inviteToken || inviteToken.length > 300 || password.length < 8) throw new AppError("VALIDATION_ERROR")

        // Hash first, so the response takes the same time whether or not the invitation is good.
        const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds)
        const user = await this.db.completeSignup(hashToken(inviteToken), passwordHash)
        if (!user) throw new AppError("SIGNUP_NOT_ALLOWED")
        return user
    }

    async login(email: string, password: string) {
        const user = await this.db.findUserByEmail(email.trim().toLowerCase())
        if (!user) {
            await bcrypt.compare(password, this.dummyHash)
            throw new AppError("INVALID_CREDENTIALS")
        }

        const match = await bcrypt.compare(password, user.passwordHash)
        if (!match) throw new AppError("INVALID_CREDENTIALS")
        // The schema has an MFA flag but the app cannot check a code yet: refuse rather than skip it.
        if (user.mfaEnabled) throw new AppError("MFA_NOT_SUPPORTED")

        return { ...(await this.startSession(user.id, user.role)), user }
    }

    async logout(refreshToken: string) {
        await this.db.revokeRefreshToken(hashToken(refreshToken))
    }

    /** Swap a refresh token for a new pair. Each refresh token works once. */
    async refresh(refreshToken: string) {
        const owner = await this.db.consumeRefreshToken(hashToken(refreshToken))
        if (!owner) throw new AppError("INVALID_TOKEN")
        return this.startSession(owner.id, owner.role)
    }

    private async startSession(userId: string, role: Role) {
        const { token: refreshToken, hash } = randomToken()
        await this.db.storeRefreshToken({ userId, tokenHash: hash, expiresAt: new Date(Date.now() + this.config.refreshTtlMilliseconds) })
        return { accessToken: generateAccessToken(this.config, userId, role), refreshToken }
    }
}
