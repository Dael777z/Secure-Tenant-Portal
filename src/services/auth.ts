import bcrypt from "bcrypt"
import { randomBytes } from "node:crypto"

import { silentLogger, type LogService } from "../logging"
import { AppError } from "../types/errors"
import type { UserRecord } from "../types/records"
import type { AuthStore } from "../types/stores"
import { isTooCommon } from "../utils/password"
import { decryptSecret, encryptSecret } from "../utils/secrets"
import { newTotpSecret, otpauthUri, verifyTotp } from "../utils/totp"
import { generateAccessToken, hashToken, randomToken, type AccessTokenConfig } from "../utils/tokens"

/** Failed sign-ins on one account, within this window, that are worth a warning in the log. */
const SUSPICIOUS_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const MAX_TRACKED_ACCOUNTS = 10_000
/** Wrong two-step codes on one account, within the window, before the code step is closed until the window ends. */
const MAX_WRONG_CODES = 5

export interface AuthConfig extends AccessTokenConfig {
    bcryptRounds: number
    refreshTtlMilliseconds: number
    /** A staff session ends this long after its sign-in, however active it is. */
    staffSessionMaxMilliseconds: number
    /** Staff cannot sign in without two-step sign-in. When false, only accounts that have set it up are asked. */
    requireStaffMfa: boolean
    /** Encrypts authenticator secrets before they are stored. */
    tokenEncryptionKey: string
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
    /**
     * Recent wrong two-step codes per account. Unlike wrong passwords these do close the door for a while:
     * only someone who already has the password gets this far, and 6 digits must not be guessable.
     * shortcut: kept in this process's memory, so move it to the database before running more than one app container.
     */
    private readonly wrongCodes = new Map<string, { count: number; since: number }>()

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
            await this.recordEvent(user.id, "signup_completed", "Finished signing up", {})
            return user
        }, (user) => ({ userId: user.id }))
    }

    // logs auth.login.succeeded { userId, role } or auth.login.failed { reason }; the reason stays in the log, never in the response
    /** `code` is the 6 digits from a staff member's authenticator app: without it they get MFA_REQUIRED and send it again with one. */
    async login(email: string, password: string, context: { ip?: string } = {}, code?: string) {
        const user = await this.checkPassword(email, password, context)
        // A code sent for an account still in setup is checked too: the first right one is what finishes setup.
        if (user.role !== "tenant" && (user.mfaEnabled || this.config.requireStaffMfa || code)) await this.checkCode(user, code, context)

        const session = await this.startSession(user.id)
        if (!session) throw new AppError("INVALID_CREDENTIALS")   // deactivated or reset since the lookup above
        this.log.info("auth.login.succeeded", { userId: user.id, role: user.role })
        await this.recordEvent(user.id, "login_success", "Signed in", context)
        return { ...session, user }
    }

    /**
     * Start (or restart) two-step setup for a staff account that does not have it on: a new secret for
     * their authenticator app. Nothing is on until they sign in with a code from it. The password is
     * asked for again because nobody is signed in yet.
     */
    // logs auth.mfa.setup_started { userId }
    async beginMfaSetup(email: string, password: string, context: { ip?: string } = {}) {
        const user = await this.checkPassword(email, password, context)
        const secret = newTotpSecret()
        // Once it is on, a new phone needs a property manager's "Reset sign-in", not just the password.
        if (user.role === "tenant" || user.mfaEnabled || !(await this.db.beginMfa(user.id, encryptSecret(secret, this.config.tokenEncryptionKey)))) throw new AppError("FORBIDDEN")
        this.log.info("auth.mfa.setup_started", { userId: user.id })
        await this.recordEvent(user.id, "mfa_setup", "Started two-step sign-in setup", context)
        return { secret, uri: otpauthUri(secret, user.email) }
    }

    /** The account for this email and password, or INVALID_CREDENTIALS (the same answer for an unknown email). */
    private async checkPassword(email: string, password: string, context: { ip?: string }): Promise<UserRecord> {
        const normalized = email.trim().toLowerCase()
        const user = await this.db.findUserByEmail(normalized)
        // An unknown email is compared against a dummy hash, so it takes as long as a wrong password.
        const match = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash)
        if (!user || !match) {
            this.log.warn("auth.login.failed", { reason: user ? "wrong password" : "unknown email", ...(user ? { userId: user.id } : {}) })
            this.noteFailure(normalized)
            // Only a known account's failures go on the Activity page (an unknown email says nothing useful).
            if (user) void this.recordEvent(user.id, "login_failed", "Sign-in failed: wrong password", context)
            throw new AppError("INVALID_CREDENTIALS")
        }
        this.failures.delete(normalized)
        return user
    }

    /** The second step, after the password was right. Throws unless `code` is the account's current code, not used before. */
    private async checkCode(user: UserRecord, code: string | undefined, context: { ip?: string }) {
        const refuse = (reason: string, errorCode: "MFA_REQUIRED" | "MFA_SETUP_REQUIRED" | "MFA_CODE_INVALID" | "MFA_LOCKED") => {
            this.log.warn("auth.login.failed", { reason, userId: user.id })
            return new AppError(errorCode)
        }
        if (!user.mfaSecretEncrypted || (!user.mfaEnabled && !code)) throw refuse("two-step setup needed", "MFA_SETUP_REQUIRED")
        if (!code) throw refuse("two-step code needed", "MFA_REQUIRED")

        const now = Date.now()
        const known = this.wrongCodes.get(user.id)
        const wrong = known && now - known.since < FAILURE_WINDOW_MS ? known : { count: 0, since: now }
        if (wrong.count >= MAX_WRONG_CODES) throw refuse("too many wrong codes", "MFA_LOCKED")

        const step = verifyTotp(decryptSecret(user.mfaSecretEncrypted, this.config.tokenEncryptionKey), code, now)
        // A code works once: a step already accepted is refused like a wrong code, even inside its own 30 seconds.
        if (step === null || !(await this.db.acceptMfaStep(user.id, step))) {
            wrong.count++
            this.wrongCodes.set(user.id, wrong)
            void this.recordEvent(user.id, "mfa_failed", "Sign-in failed: wrong two-step code", context)
            throw refuse(step === null ? "wrong code" : "code already used", "MFA_CODE_INVALID")
        }
        this.wrongCodes.delete(user.id)
    }

    /** Activity page and the Team's "last sign-in" (009). A failure to record never fails the sign-in. */
    private async recordEvent(userId: string, action: string, summary: string, context: { ip?: string }) {
        try {
            await this.db.recordSecurityEvent?.(userId, action, summary, context.ip ? { ip: context.ip } : null)
        } catch (error) {
            this.log.warn("auth.event.not_recorded", { action, error: (error as Error).message })
        }
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
    // logs auth.refresh.succeeded { userId } or auth.refresh.failed { code: INVALID_TOKEN } (unknown, used, expired, the account is gone, or a staff session past its 30 days)
    refresh(refreshToken: string) {
        let userId = ""
        return this.log.flow("auth.refresh", {}, async () => {
            const owner = await this.db.consumeRefreshToken(hashToken(refreshToken))
            if (!owner) throw new AppError("INVALID_TOKEN")
            userId = owner.id
            // The token is used up either way, so a staff session past its limit ends here: password and code again.
            if (owner.role !== "tenant" && Date.now() - owner.sessionStartedAt.getTime() > this.config.staffSessionMaxMilliseconds) throw new AppError("INVALID_TOKEN")
            const session = await this.startSession(owner.id, owner.sessionStartedAt)
            if (!session) throw new AppError("INVALID_TOKEN")
            return session
        }, () => ({ userId }))
    }

    /**
     * A new token pair, with the role and token version the account has right now (012): `authenticate`
     * compares both on every request. Null when the account is no longer active and signed up.
     * `sessionStartedAt` is passed on when a refresh continues a session; a sign-in starts a new one.
     */
    private async startSession(userId: string, sessionStartedAt?: Date) {
        const state = await this.db.findSessionState(userId)
        if (!state) return null
        const { token: refreshToken, hash } = randomToken()
        await this.db.storeRefreshToken({ userId, tokenHash: hash, expiresAt: new Date(Date.now() + this.config.refreshTtlMilliseconds), sessionStartedAt })
        return { accessToken: generateAccessToken(this.config, userId, state.role, state.tokenVersion), refreshToken }
    }
}
