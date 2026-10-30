import bcrypt from "bcrypt"
import type { AuthStore } from "../types/stores"
import type { NewRefreshToken } from "../types/inputs"
import type { SessionUser, StaffProfile, UserRecord } from "../types/records"
import { hashToken } from "../utils/tokens"
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

    account(email: string, password: string, role: "admin" | "tenant", extra: { mfaEnabled?: boolean } = {}) {
        this.users.push({
            id: `${role}:${this.next++}`, email, passwordHash: bcrypt.hashSync(password, 4), role, mfaEnabled: extra.mfaEnabled ?? false,
        })
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

    async storeRefreshToken(data: NewRefreshToken) {
        const owner = this.users.find((u) => u.id === data.userId)!
        this.tokens.set(data.tokenHash, { owner: { id: owner.id, email: owner.email, role: owner.role }, revoked: false, expiresAt: data.expiresAt })
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

const config = {
    accessSecret: "unit-test-secret",
    jwtIssuer: "portal",
    jwtAudience: "portal-web",
    accessTtlSeconds: 900,
    bcryptRounds: 4,
    refreshTtlMilliseconds: 60_000,
}

function setup() {
    const store = new FakeAuthStore()
    const auth = new AuthService(store, config)
    return { store, auth }
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

    it("refuses an account with MFA on rather than skipping the second factor", async () => {
        const { store, auth } = setup()
        store.account("boss@example.com", "correct horse", "admin", { mfaEnabled: true })
        await expect(auth.login("boss@example.com", "correct horse")).rejects.toMatchObject({ code: "MFA_NOT_SUPPORTED" })
    })

    it("logout revokes the refresh token", async () => {
        const { store, auth } = setup()
        store.account("resident@example.com", "correct horse", "tenant")
        const session = await auth.login("resident@example.com", "correct horse")
        await auth.logout(session.refreshToken)
        await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: "INVALID_TOKEN" })
    })
})
