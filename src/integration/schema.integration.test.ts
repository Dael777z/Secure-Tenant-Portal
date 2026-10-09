// Angel's schema rules (db/migrations), checked against a real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Pool } from "pg"
import { dropSchema, freshSchema, hasDatabase } from "./helpers"

const SCHEMA = "it_schema"

describe.skipIf(!hasDatabase)("schema rules (001, 002)", () => {
    let db: Pool

    beforeAll(async () => {
        db = await freshSchema(SCHEMA)
    })

    afterAll(async () => {
        if (db) await dropSchema(db, SCHEMA)
    })

    const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        (await db.query<T>(sql, params)).rows[0]!

    async function property(name = "Woodcrest") {
        return (await one<{ pid: number }>("INSERT INTO Property (Name, Address) VALUES ($1, '1 Main St') RETURNING pID AS pid", [name])).pid
    }
    async function unit(pid: number, num = "101") {
        return (await one<{ uid: number }>("INSERT INTO Units (pID, UnitNum) VALUES ($1, $2) RETURNING uID AS uid", [pid, num])).uid
    }
    async function tenant(email: string) {
        return (await one<{ tid: number }>("INSERT INTO Tenants (Name, Email) VALUES ('T', $1) RETURNING tID AS tid", [email])).tid
    }
    async function lease(uid: number) {
        return (await one<{ leaseid: number }>(
            "INSERT INTO Lease (uID, start_date, ammount_owed) VALUES ($1, '2026-09-01', 950) RETURNING LeaseID AS leaseid",
            [uid],
        )).leaseid
    }

    it("deleting a property removes its units", async () => {
        const pid = await property("To delete")
        await unit(pid, "A")
        await unit(pid, "B")
        await db.query("DELETE FROM Property WHERE pID = $1", [pid])
        expect((await db.query("SELECT 1 FROM Units WHERE pID = $1", [pid])).rowCount).toBe(0)
    })

    it("a unit with a lease cannot be deleted (and so neither can its property)", async () => {
        const pid = await property()
        const uid = await unit(pid)
        await lease(uid)
        await expect(db.query("DELETE FROM Units WHERE uID = $1", [uid])).rejects.toMatchObject({ code: "23503" })
        await expect(db.query("DELETE FROM Property WHERE pID = $1", [pid])).rejects.toMatchObject({ code: "23503" })
    })

    it("a lease with payments cannot be deleted; one without payments takes its tenant links with it", async () => {
        const uid = await unit(await property())
        const paid = await lease(uid)
        await db.query("INSERT INTO Payment (LeaseID, ammount) VALUES ($1, 100)", [paid])
        await expect(db.query("DELETE FROM Lease WHERE LeaseID = $1", [paid])).rejects.toMatchObject({ code: "23503" })

        const unpaid = await lease(uid)
        const tid = await tenant("links@example.com")
        await db.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [unpaid, tid])
        await db.query("DELETE FROM Lease WHERE LeaseID = $1", [unpaid])
        expect((await db.query("SELECT 1 FROM Lease_Tenants WHERE LeaseID = $1", [unpaid])).rowCount).toBe(0)
        expect((await db.query("SELECT 1 FROM Tenants WHERE tID = $1", [tid])).rowCount).toBe(1)
    })

    it("several tenants can share a lease, but the same tenant only once", async () => {
        const id = await lease(await unit(await property()))
        const a = await tenant("cosigner-a@example.com")
        const b = await tenant("cosigner-b@example.com")
        await db.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2), ($1, $3)", [id, a, b])
        await expect(db.query("INSERT INTO Lease_Tenants (LeaseID, tID) VALUES ($1, $2)", [id, a])).rejects.toMatchObject({ code: "23505" })
    })

    it("maintenance requests start as submitted, accept only the three statuses, and outlive the tenant", async () => {
        const uid = await unit(await property())
        const tid = await tenant("leaving@example.com")
        const request = await one<{ mid: number; status: string }>(
            "INSERT INTO Maintenance_T (uID, tID) VALUES ($1, $2) RETURNING mID AS mid, status",
            [uid, tid],
        )
        expect(request.status).toBe("submitted")
        await expect(db.query("UPDATE Maintenance_T SET status = 'closed' WHERE mID = $1", [request.mid])).rejects.toMatchObject({ code: "23514" })
        await db.query("UPDATE Maintenance_T SET status = 'in_progress' WHERE mID = $1", [request.mid])

        await db.query("DELETE FROM Tenants WHERE tID = $1", [tid])
        const after = await one<{ tid: number | null; status: string }>("SELECT tID AS tid, status FROM Maintenance_T WHERE mID = $1", [request.mid])
        expect(after).toEqual({ tid: null, status: "in_progress" })
    })

    it("an invited tenant has no password, and nobody can be signed up without one", async () => {
        const tid = await tenant("invited@example.com")
        const row = await one<{ signed_up: boolean; password_hash: string | null }>(
            "SELECT signed_up, password_hash FROM Tenants WHERE tID = $1",
            [tid],
        )
        expect(row).toEqual({ signed_up: false, password_hash: null })
        await expect(db.query("UPDATE Tenants SET signed_up = true WHERE tID = $1", [tid])).rejects.toMatchObject({ code: "23514" })
        await db.query("UPDATE Tenants SET signed_up = true, password_hash = 'x' WHERE tID = $1", [tid])
    })

    it("an email belongs to one account: tenant or staff, not both, and is stored lower case", async () => {
        await db.query("INSERT INTO Admin (name, email, password_hash) VALUES ('M', 'shared@example.com', 'x')")
        await expect(tenant("shared@example.com")).rejects.toMatchObject({ code: "23505" })
        await tenant("only-tenant@example.com")
        await expect(
            db.query("INSERT INTO Admin (name, email, password_hash) VALUES ('M', 'only-tenant@example.com', 'x')"),
        ).rejects.toMatchObject({ code: "23505" })
        await expect(tenant("Upper@Example.com")).rejects.toMatchObject({ code: "23514" })
    })

    it("staff roles are limited to the skeleton's three", async () => {
        const row = await one<{ role: string }>(
            "INSERT INTO Admin (name, email, password_hash) VALUES ('Default', 'default-role@example.com', 'x') RETURNING role",
        )
        expect(row.role).toBe("property_manager")
        await expect(
            db.query("INSERT INTO Admin (name, email, password_hash, role) VALUES ('X', 'x-role@example.com', 'x', 'tenant')"),
        ).rejects.toMatchObject({ code: "23514" })
    })

    it("a refresh token belongs to exactly one tenant or admin, and goes when the account does", async () => {
        const tid = await tenant("sessions@example.com")
        const hash = "a".repeat(64)
        await expect(
            db.query("INSERT INTO Refresh_Tokens (token_hash, expires_at) VALUES ($1, now() + interval '1 day')", [hash]),
        ).rejects.toMatchObject({ code: "23514" })
        await db.query("INSERT INTO Refresh_Tokens (tID, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [tid, hash])
        await db.query("DELETE FROM Tenants WHERE tID = $1", [tid])
        expect((await db.query("SELECT 1 FROM Refresh_Tokens WHERE token_hash = $1", [hash])).rowCount).toBe(0)
    })
})
