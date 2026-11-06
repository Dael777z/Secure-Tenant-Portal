import bcrypt from "bcrypt"
import { describe, expect, it } from "vitest"

import { createLogger } from "../logging"
import { AppError } from "../types/errors"
import type { AuthStore } from "../types/stores"
import { AuthService } from "./auth"

const config = { accessSecret: "s".repeat(32), jwtIssuer: "portal", jwtAudience: "portal-web", accessTtlSeconds: 900, bcryptRounds: 4, refreshTtlMilliseconds: 60_000 }
const hash = bcrypt.hashSync("the-right-password", 4)

function setup() {
    const lines: Array<{ event: string; metadata?: Record<string, unknown> }> = []
    const log = createLogger({ logFile: "", serviceName: "portal", mode: "development" }, { write: (chunk: string) => { lines.push(JSON.parse(chunk)) } })
    const signups: string[] = []
    const db = {
        findUserByEmail: async (email: string) => (email === "owner@example.com" ? { id: "tenant:1", email, passwordHash: hash, role: "tenant", mfaEnabled: false } : null),
        storeRefreshToken: async () => {},
        completeSignup: async (_token: string, passwordHash: string) => { signups.push(passwordHash); return { id: "tenant:1", email: "owner@example.com", role: "tenant" } },
    } as unknown as AuthStore
    return { auth: new AuthService(db, config, log), lines, signups }
}
const suspicious = (lines: Array<{ event: string; metadata?: Record<string, unknown> }>) => lines.filter((l) => l.event === "auth.login.suspicious")

describe("sign-in failures", () => {
    it("warns once when one account is hit with 10 wrong passwords, counting every address and unknown emails too", async () => {
        const { auth, lines } = setup()
        for (let i = 0; i < 9; i++) await expect(auth.login("owner@example.com", "wrong")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
        expect(suspicious(lines)).toHaveLength(0)
        await expect(auth.login("OWNER@example.com ", "wrong")).rejects.toBeInstanceOf(AppError)
        expect(suspicious(lines)).toHaveLength(1)
        expect(suspicious(lines)[0]!.metadata).toMatchObject({ failures: 10 })
        expect(JSON.stringify(suspicious(lines))).not.toContain("owner@example.com")   // the log holds no email
        for (let i = 0; i < 12; i++) await expect(auth.login("owner@example.com", "wrong")).rejects.toBeInstanceOf(AppError)
        expect(suspicious(lines)).toHaveLength(1)   // once per burst, not once per attempt

        for (let i = 0; i < 10; i++) await expect(auth.login("nobody@example.com", "wrong")).rejects.toBeInstanceOf(AppError)
        expect(suspicious(lines)).toHaveLength(2)   // an email that does not exist is counted the same way
    })

    it("never locks the owner out: the right password still works after any number of failures", async () => {
        const { auth } = setup()
        for (let i = 0; i < 40; i++) await expect(auth.login("owner@example.com", "wrong")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
        const session = await auth.login("owner@example.com", "the-right-password")
        expect(session.accessToken).toBeTruthy()
    })

    it("starts counting again after a successful sign-in", async () => {
        const { auth, lines } = setup()
        for (let i = 0; i < 8; i++) await expect(auth.login("owner@example.com", "wrong")).rejects.toBeInstanceOf(AppError)
        await auth.login("owner@example.com", "the-right-password")
        for (let i = 0; i < 8; i++) await expect(auth.login("owner@example.com", "wrong")).rejects.toBeInstanceOf(AppError)
        expect(suspicious(lines)).toHaveLength(0)
    })
})

describe("choosing a password at sign-up", () => {
    it("refuses a common password with its own error, before anything is saved", async () => {
        const { auth, signups } = setup()
        await expect(auth.signup("invite-token", "12345678")).rejects.toMatchObject({ code: "PASSWORD_TOO_COMMON" })
        await expect(auth.signup("invite-token", "Password123!")).rejects.toMatchObject({ code: "PASSWORD_TOO_COMMON" })
        expect(signups).toHaveLength(0)
        await expect(auth.signup("invite-token", "blue.kettle.window")).resolves.toMatchObject({ email: "owner@example.com" })
        expect(signups).toHaveLength(1)
    })
})
