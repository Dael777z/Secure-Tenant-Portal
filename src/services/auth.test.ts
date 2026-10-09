import { describe, expect, it } from "vitest"
import { AppError } from "../types/errors"
import { MemoryDatabase } from "./memory-db"
import { login, refresh, signup } from "./auth"

describe("auth service", () => {
    it("normalizes signup email and lets an invited tenant sign up only once", async () => {
        const database = new MemoryDatabase()
        await database.inviteTenant({ name: "Resident", email: "resident@example.com" })

        const user = await signup(database, " Resident@Example.com ", "correct horse")

        expect(user.email).toBe("resident@example.com")
        await expect(signup(database, "resident@example.com", "another password"))
            .rejects.toMatchObject({ code: "SIGNUP_NOT_ALLOWED" })
    })

    it("refuses sign-up for an address the office has not added", async () => {
        await expect(signup(new MemoryDatabase(), "stranger@example.com", "correct horse"))
            .rejects.toMatchObject({ code: "SIGNUP_NOT_ALLOWED" })
    })

    it("rotates refresh tokens and rejects the previous token", async () => {
        const database = new MemoryDatabase()
        await database.inviteTenant({ name: "Resident", email: "resident@example.com" })
        await signup(database, "resident@example.com", "correct horse")

        const firstLogin = await login(database, "resident@example.com", "correct horse")
        const rotated = await refresh(database, firstLogin.refresh_token)

        expect(rotated.access_token).toEqual(expect.any(String))
        expect(rotated.refresh_token).not.toBe(firstLogin.refresh_token)
        await expect(refresh(database, firstLogin.refresh_token))
            .rejects.toMatchObject({ code: "INVALID_TOKEN" })
    })

    it("uses one generic error for unknown users and wrong passwords", async () => {
        const database = new MemoryDatabase()
        await database.inviteTenant({ name: "Resident", email: "resident@example.com" })
        await signup(database, "resident@example.com", "correct horse")

        await expect(login(database, "missing@example.com", "correct horse"))
            .rejects.toBeInstanceOf(AppError)
        await expect(login(database, "resident@example.com", "wrong password"))
            .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })
    })
})