// The same checks against both stores, so the in-memory store used in
// development behaves like the Postgres one the app will run on.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Pool } from "pg"
import { MemoryDatabase } from "../services/memory-db"
import { PostgresDatabase, parseUserId } from "../services/postgres-db"
import type { DatabaseInterface } from "../types/interfaces"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_repository"
let pool: Pool | undefined

beforeAll(async () => {
    if (hasDatabase) pool = await freshSchema(SCHEMA)
})

afterAll(async () => {
    if (pool) await dropSchema(pool, SCHEMA)
})

const stores: Array<[string, () => DatabaseInterface]> = [["memory", () => new MemoryDatabase()]]
if (hasDatabase) stores.push(["postgres", () => new PostgresDatabase(pool!)])

describe.each(stores)("%s store", (name, make) => {
    const email = (local: string) => `${local}.${name}@example.com`

    it("an invited tenant cannot sign in until they sign up, and can sign up once", async () => {
        const db = make()
        const invited = await db.inviteTenant({ name: "Dana", email: email("Dana"), phone: null })
        expect(invited.email).toBe(email("dana"))

        expect(await db.findUserByEmail(email("dana"))).toBeNull()
        expect(await db.findUserByID(invited.id)).toBeNull()

        const user = await db.completeSignup(email("dana"), "hash-1")
        expect(user).toMatchObject({ id: invited.id, email: email("dana"), role: "tenant", password_h: "hash-1" })
        expect(await db.completeSignup(email("dana"), "hash-2")).toBeNull()
        expect((await db.findUserByEmail(email("dana")))?.password_h).toBe("hash-1")
    })

    it("an address that was never invited cannot sign up", async () => {
        expect(await make().completeSignup(email("nobody"), "hash")).toBeNull()
    })

    it("staff accounts carry their role", async () => {
        const db = make()
        const staff = await db.createUser({ email: email("fixer"), password_h: "h", role: "maintenance_staff", name: "Fixer" })
        expect((await db.findUserByID(staff.id))?.role).toBe("maintenance_staff")
        expect((await db.findUserByEmail(email("fixer")))?.id).toBe(staff.id)
    })

    it("refresh tokens: stored by hash, revoked one at a time or all together", async () => {
        const db = make()
        const user = await db.createUser({ email: email("sessions"), password_h: "h", role: "tenant", name: "S" })
        const later = new Date(Date.now() + 60_000)
        const hashes = ["1", "2", "3"].map((c) => c.repeat(64))
        for (const token_h of hashes) await db.storeRefreshToken({ user_id: user.id, token_h, expiresAt: later })

        const found = await db.findRefreshTokenByHash(hashes[0]!)
        expect(found).toMatchObject({ user_id: user.id, token_h: hashes[0], revoked: false })

        await db.revokeRefreshToken(hashes[0]!)
        expect((await db.findRefreshTokenByHash(hashes[0]!))?.revoked).toBe(true)
        expect((await db.findRefreshTokenByHash(hashes[1]!))?.revoked).toBe(false)

        await db.revokeAllTokensForUser(user.id)
        for (const token_h of hashes) expect((await db.findRefreshTokenByHash(token_h))?.revoked).toBe(true)
        expect(await db.findRefreshTokenByHash("f".repeat(64))).toBeNull()
    })
})

describe("user ids in the Postgres store", () => {
    it("say which table the person is in", () => {
        expect(parseUserId("tenant:5")).toEqual({ table: "tenant", id: 5 })
        expect(parseUserId("admin:12")).toEqual({ table: "admin", id: 12 })
        for (const bad of ["5", "tenant:0", "tenant:-1", "owner:3", "tenant:5;drop", "admin:99999999999"]) {
            expect(parseUserId(bad)).toBeNull()
        }
    })
})
