import bcrypt from "bcrypt"
import type { AuthStore } from "../types/stores"
import type { NewRefreshToken } from "../types/inputs"
import type { SessionUser, StaffProfile, UserRecord } from "../types/records"
import { hashToken } from "../utils/tokens"
import { totpCode, totpStep } from "../utils/totp"
import { describe, expect, it } from "vitest"
import { AppError } from "../types/errors"
import { AuthService } from "./auth"

interface RefreshTokenSlot { owner: SessionUser; revoked: boolean; expiresAt: Date }

/** AuthStore in memory, so AuthService can be tested without a database. */
class FakeAuthStore implements AuthStore {
    private users: Array<UserRecord & { invited?: string }> = []
    private tokens = new Map<string, RefreshTokenSlot>()
    lastSignupHash = ""
    private next = 1
    private lastStep = new Map<string, number>()

    /** Make every open session look `ms` older. */
    ageSessions(ms: number) {
        for (const slot of this.tokens.values()) slot.owner.sessionStartedAt = new Date(slot.owner.sessionStartedAt.getTime() - ms)
    }

    async beginMfa(userId: string, secretEncrypted: string) {
        const user = this.users.find((u) => u.id === userId)
        if (!user || user.role === "tenant" || user.mfaEnabled) return false
        user.mfaSecretEncrypted = secretEncrypted
        return true
    }

    async acceptMfaStep(userId: string, step: number) {
        const user = this.users.find((u) => u.id === userId)
        if (!user?.mfaSecretEncrypted || (this.lastStep.get(userId) ?? -1) >= step) return false
        this.lastStep.set(userId, step)
        user.mfaEnabled = true
        return true
    }

    account(email: string, password: string, role: "admin" | "tenant") {
        this.users.push({ id: `${role}:${this.next++}`, email, passwordHash: bcrypt.hashSync(password, 4), role, mfaEnabled: false })
    }

    /** An invited tenant: no password until sign-up. `token` is the raw token; only its hash is kept. */
    invite(email: string, token: string) {
        this.users.push({ id: `tenant:${this.next++}`, email, passwordHash: "", role: "tenant", mfaEnabled: false, invited: hashToken(token) })
    }

    async findUserByEmail(email: string) {
        const user = this.users.find((u) => u.email === email && !u.invited)
        return user ?? null
    }

    async completeSignup(tokenHash: string, passwordHash: string) {
        this.lastSignupHash = tokenHash
        const user = this.users.find((u) => u.invited === tokenHash)
        if (!user) return null
        user.invited = undefined
        user.passwordHash = passwordHash
        return user
    }

    async findStaffProfile(): Promise<StaffProfile | null> { return null }

    async findSessionState(userId: string) {
        const user = this.users.find((u) => u.id === userId && !u.invited)
        return user ? { role: user.role, tokenVersion: 0 } : null
    }

    async storeRefreshToken(data: NewRefreshToken) {
        const owner = this.users.find((u) => u.id === data.userId)!
        this.tokens.set(data.tokenHash, { owner: { id: owner.id, email: owner.email, role: owner.role, sessionStartedAt: data.sessionStartedAt ?? new Date() }, revoked: false, expiresAt: data.expiresAt })
    }

    async consumeRefreshToken(tokenHash: string) {
        const slot = this.tokens.get(tokenHash)
        if (!slot || slot.revoked || slot.expiresAt.getTime() <= Date.now()) return null
        slot.revoked = true
        return slot.owner
    }

    async revokeRefreshToken(tokenHash: string) {
        const slot = this.tokens.get(tokenHash)
        if (slot) slot.revoked = true
    }

    async revokeAllTokensForUser(userId: string) {
        for (const slot of this.tokens.values()) if (slot.owner.id === userId) slot.revoked = true
    }
}

const DAY = 24 * 60 * 60 * 1000
const config = {
    accessSecret: "unit-test-secret",
    jwtIssuer: "portal",
    jwtAudience: "portal-web",
    accessTtlSeconds: 900,
    bcryptRounds: 4,
    refreshTtlMilliseconds: 60_000,
    staffSessionMaxMilliseconds: 30 * DAY,
    requireStaffMfa: false,
    tokenEncryptionKey: "unit-test-encryption-key",
}

function setup(over: Partial<typeof config> = {}) {
    const store = new FakeAuthStore()
    const auth = new AuthService(store, { ...config, ...over })
    return { store, auth }
}

/** A code no authenticator would show right now. */
function wrongCode(secret: string): string {
    const right = [-1, 0, 1].map((d) => totpCode(secret, totpStep() + d))
    return ["000000", "000001", "000002", "000003"].find((c) => !right.includes(c))!
}

describe("auth service (against a fake store, no database)", () => {
    it("signs an invited tenant up with the token from their link, and only once", async () => {
        const { store, auth } = setup()
        store.invite("resident@example.com", "the-invite-token")

        const user = await auth.signup("the-invite-token", "correct horse")
        expect(user).toMatchObject({ email: "resident@example.com", role: "tenant" })

        await expect(auth.signup("the-invite-token", "another password")).rejects.toMatchObject({ code: "SIGNUP_NOT_ALLOWED" })
    })

    it("refuses a token that was never issued, and a short password", async () => {
        const { auth } = setup()
        await expect(auth.signup("made-up", "correct horse")).rejects.toMatchObject({ code: "SIGNUP_NOT_ALLOWED" })
        await expect(auth.signup("whatever", "short")).rejects.toMatchObject({ code: "VALIDATION_ERROR" })
    })

    it("looks the invite up by its hash, never by the raw token", async () => {
        const { store, auth } = setup()
        store.invite("resident@example.com", "the-invite-token")
        await auth.signup("the-invite-token", "correct horse")
        expect(store.lastSignupHash).toBe(hashToken("the-invite-token"))
    })

    it("rotates refresh tokens and rejects the previous token", async () => {
        const { store, auth } = setup()
        store.account("resident@example.com", "correct horse", "tenant")

        const first = await auth.login("resident@example.com", "correct horse")
        const rotated = await auth.refresh(first.refreshToken)

        expect(rotated.accessToken).toEqual(expect.any(String))
        expect(rotated.refreshToken).not.toBe(first.refreshToken)
        await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" })
    })

    it("uses one generic error for unknown users and wrong passwords", async () => {
        const { store, auth } = setup()
        store.account("resident@example.com", "correct horse", "tenant")

        await expect(auth.login("missing@example.com", "correct horse")).rejects.toBeInstanceOf(AppError)
        await expect(auth.login("resident@example.com", "wrong password")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
    })

    it("staff set up two-step sign-in, then need a new code at every sign-in (013)", async () => {
        const { store, auth } = setup({ requireStaffMfa: true })
        store.account("boss@example.com", "correct horse", "admin")
        const boss = ["boss@example.com", "correct horse", {}] as const

        // No way in without it, and the setup itself needs the password.
        await expect(auth.login(...boss)).rejects.toMatchObject({ code: "MFA_SETUP_REQUIRED" })
        await expect(auth.beginMfaSetup("boss@example.com", "wrong password")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
        const { secret, uri } = await auth.beginMfaSetup("boss@example.com", "correct horse")
        expect(uri).toContain(`secret=${secret}`)
        // Having a secret is not enough: it is on only after a code from it.
        await expect(auth.login(...boss)).rejects.toMatchObject({ code: "MFA_SETUP_REQUIRED" })
        await expect(auth.login(...boss, wrongCode(secret))).rejects.toMatchObject({ code: "MFA_CODE_INVALID" })

        const code = totpCode(secret, totpStep())
        await expect(auth.login(...boss, code)).resolves.toMatchObject({ user: { email: "boss@example.com" } })
        // From now on: a code every time, each code once, and no second setup with just the password.
        await expect(auth.login(...boss)).rejects.toMatchObject({ code: "MFA_REQUIRED" })
        await expect(auth.login(...boss, code)).rejects.toMatchObject({ code: "MFA_CODE_INVALID" })
        await expect(auth.login(...boss, totpCode(secret, totpStep() + 1))).resolves.toMatchObject({ user: { email: "boss@example.com" } })
        await expect(auth.beginMfaSetup("boss@example.com", "correct horse")).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("tenants are never asked for a code and cannot start setup", async () => {
        const { store, auth } = setup({ requireStaffMfa: true })
        store.account("resident@example.com", "correct horse", "tenant")
        await expect(auth.login("resident@example.com", "correct horse")).resolves.toMatchObject({ user: { role: "tenant" } })
        await expect(auth.beginMfaSetup("resident@example.com", "correct horse")).rejects.toMatchObject({ code: "FORBIDDEN" })
    })

    it("where it is not required, staff sign in with a password until they set it up, and with a code after", async () => {
        const { store, auth } = setup()
        store.account("boss@example.com", "correct horse", "admin")
        await expect(auth.login("boss@example.com", "correct horse")).resolves.toBeTruthy()
        const { secret } = await auth.beginMfaSetup("boss@example.com", "correct horse")
        await auth.login("boss@example.com", "correct horse", {}, totpCode(secret, totpStep()))
        await expect(auth.login("boss@example.com", "correct horse")).rejects.toMatchObject({ code: "MFA_REQUIRED" })
    })

    it("closes the code step after five wrong codes, even to the right one", async () => {
        const { store, auth } = setup({ requireStaffMfa: true })
        store.account("boss@example.com", "correct horse", "admin")
        const { secret } = await auth.beginMfaSetup("boss@example.com", "correct horse")
        for (let i = 0; i < 5; i++) await expect(auth.login("boss@example.com", "correct horse", {}, wrongCode(secret))).rejects.toMatchObject({ code: "MFA_CODE_INVALID" })
        await expect(auth.login("boss@example.com", "correct horse", {}, totpCode(secret, totpStep()))).rejects.toMatchObject({ code: "MFA_LOCKED" })
    })

    it("a staff session ends 30 days after its sign-in however often it is refreshed; a tenant's does not", async () => {
        const { store, auth } = setup()
        store.account("boss@example.com", "correct horse", "admin")
        store.account("resident@example.com", "correct horse", "tenant")
        let staff = await auth.login("boss@example.com", "correct horse")
        let tenant = await auth.login("resident@example.com", "correct horse")

        store.ageSessions(29 * DAY)
        staff = { ...staff, ...(await auth.refresh(staff.refreshToken)) }   // still inside, and the new token keeps the old start
        store.ageSessions(2 * DAY)
        await expect(auth.refresh(staff.refreshToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" })
        await expect(auth.refresh(tenant.refreshToken)).resolves.toBeTruthy()
    })

    it("logout revokes the refresh token", async () => {
        const { store, auth } = setup()
        store.account("resident@example.com", "correct horse", "tenant")
        const session = await auth.login("resident@example.com", "correct horse")
        await auth.logout(session.refreshToken)
        await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" })
    })
})

describe("sign-in events (009)", () => {
    it("records the sign-in with the address, and a failure to record never blocks it", async () => {
        const store = new FakeAuthStore()
        store.account("resident@example.com", "correct horse", "tenant")
        const events: unknown[][] = []
        const recording = Object.assign(store, { recordSecurityEvent: async (...args: unknown[]) => { events.push(args) } })
        const warnings: string[] = []
        const log = { flow: (_e: string, _m: unknown, work: () => unknown) => work(), info() {}, warn: (event: string) => { warnings.push(event) }, error() {} }
        const auth = new AuthService(recording, config, log as never)
        await auth.login("resident@example.com", "correct horse", { ip: "203.0.113.9" })
        expect(events[0]).toEqual([expect.stringMatching(/^tenant:/), "login_success", "Signed in", { ip: "203.0.113.9" }])
        await auth.login("resident@example.com", "correct horse")
        expect(events[1]![3]).toBeNull()
        recording.recordSecurityEvent = async () => { throw new Error("database is down") }
        await expect(auth.login("resident@example.com", "correct horse")).resolves.toMatchObject({ user: { email: "resident@example.com" } })
        expect(warnings).toContain("auth.event.not_recorded")
    })
})
