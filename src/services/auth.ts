import bcrypt from "bcrypt"
import { randomBytes } from "node:crypto"

import { silentLogger, type LogService } from "../logging"
import type { Role } from "../types/access"
import { AppError } from "../types/errors"
import type { AuthStore } from "../types/stores"
import { isTooCommon } from "../utils/password"
import { generateAccessToken, hashToken, randomToken, type AccessTokenConfig } from "../utils/tokens"

/** Failed sign-ins on one account, within this window, that are worth a warning in the log. */
const SUSPICIOUS_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_ACCOUNTS = 10_000

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
    /** Recent failed sign-ins per email: only counted, never used to refuse anyone (that would let an attacker lock the owner out). */
    private readonly failures = new Map<string, { count: number; since: number }>()

    constructor(private readonly db: AuthStore, private readonly config: AuthConfig, private readonly log: LogService = silentLogger) {
        this.dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), config.bcryptRounds)
    }

    // logs auth.signup.succeeded { userId } or auth.signup.failed { code }
    signup(inviteToken: string, password: string) {
        return this.log.flow("auth.signup", {}, async () => {
            if (!inviteToken || inviteToken.length > 300 || password.length < 8) throw new AppError("VALIDATION_ERROR")
            if (isTooCommon(password)) throw new AppError("PASSWORD_TOO_COMMON")

            // Hash first, so the response takes the same time whether or not the invitation is good.
            const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds)
            const user = await this.db.completeSignup(hashToken(inviteToken), passwordHash)
            if (!user) throw new AppError("SIGNUP_NOT_ALLOWED")
            return user
        }, (user) => ({ userId: user.id }))
    }

    // logs auth.login.succeeded { userId, role } or auth.login.failed { reason }; the reason stays in the log, never in the response
    async login(email: string, password: string) {
        const normalized = email.trim().toLowerCase()
        const refuse = (reason: string, code: "INVALID_CREDENTIALS" | "MFA_NOT_SUPPORTED", userId?: string) => {
            this.log.warn("auth.login.failed", { reason, ...(userId ? { userId } : {}) })
            if (code === "INVALID_CREDENTIALS") this.noteFailure(normalized)
            return new AppError(code)
        }
        const user = await this.db.findUserByEmail(normalized)
        if (!user) {
            await bcrypt.compare(password, this.dummyHash)
            throw refuse("unknown email", "INVALID_CREDENTIALS")
        }

        const match = await bcrypt.compare(password, user.passwordHash)
        if (!match) throw refuse("wrong password", "INVALID_CREDENTIALS", user.id)
        // The schema has an MFA flag but the app cannot check a code yet: refuse rather than skip it.
        if (user.mfaEnabled) throw refuse("mfa required", "MFA_NOT_SUPPORTED", user.id)

        this.failures.delete(normalized)
        const session = await this.startSession(user.id, user.role)
        this.log.info("auth.login.succeeded", { userId: user.id, role: user.role })
        return { ...session, user }
    }

    /** Count a failed sign-in, and warn once when one account is being hammered (from any number of addresses). */
    private noteFailure(email: string) {
        const now = Date.now()
        const known = this.failures.get(email)
        const entry = known && now - known.since < FAILURE_WINDOW_MS ? known : { count: 0, since: now }
        entry.count++
        if (this.failures.size >= MAX_TRACKED_ACCOUNTS) this.failures.clear()   // bounded memory beats a perfect count
        this.failures.set(email, entry)
        if (entry.count === SUSPICIOUS_FAILURES) this.log.warn("auth.login.suspicious", { failures: entry.count, windowMinutes: FAILURE_WINDOW_MS / 60000, account: hashToken(email).slice(0, 12) })
    }

    async logout(refreshToken: string) {
        await this.db.revokeRefreshToken(hashToken(refreshToken))
        this.log.info("auth.logout")
    }

    /** Swap a refresh token for a new pair. Each refresh token works once. */
    // logs auth.refresh.succeeded { userId } or auth.refresh.failed { code: INVALID_TOKEN } (unknown, used, expired or the account is gone)
    refresh(refreshToken: string) {
        let userId = ""
        return this.log.flow("auth.refresh", {}, async () => {
            const owner = await this.db.consumeRefreshToken(hashToken(refreshToken))
            if (!owner) throw new AppError("INVALID_TOKEN")
            userId = owner.id
            return this.startSession(owner.id, owner.role)
        }, () => ({ userId }))
    }

    private async startSession(userId: string, role: Role) {
        const { token: refreshToken, hash } = randomToken()
        await this.db.storeRefreshToken({ userId, tokenHash: hash, expiresAt: new Date(Date.now() + this.config.refreshTtlMilliseconds) })
        return { accessToken: generateAccessToken(this.config, userId, role), refreshToken }
    }
}
