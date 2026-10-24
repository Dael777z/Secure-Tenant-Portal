import { describe, expect, it } from "vitest"

import { decryptSecret } from "./secrets"
import { adminId, parseUserId, tenantId, tenantIdOf } from "./user-id"

describe("user ids ('tenant:5', 'admin:12')", () => {
    it("reads a valid id into its table and number", () => {
        expect(parseUserId("tenant:5")).toEqual({ table: "tenant", id: 5 })
        expect(parseUserId("admin:1234567890")).toEqual({ table: "admin", id: 1234567890 })
    })

    it("refuses anything else: other tables, zero, leading zeros, signs, spaces, huge numbers", () => {
        for (const bad of ["", "tenant", "tenant:", "tenant:0", "tenant:05", "tenant:-1", "tenant:1 ", " tenant:1", "Tenant:1", "root:1", "tenant:12345678901", "tenant:1;DROP"]) {
            expect(parseUserId(bad), JSON.stringify(bad)).toBeNull()
        }
    })

    it("builds ids the same way it reads them", () => {
        expect(parseUserId(tenantId(9))).toEqual({ table: "tenant", id: 9 })
        expect(parseUserId(adminId(3))).toEqual({ table: "admin", id: 3 })
    })

    it("tenantIdOf gives the number for a tenant, and NOT_FOUND for staff or nonsense", () => {
        expect(tenantIdOf("tenant:7")).toBe(7)
        for (const other of ["admin:7", "garbage", ""]) expect(() => tenantIdOf(other), other).toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
    })
})

describe("decryptSecret", () => {
    it("refuses a value that is not in the stored format", () => {
        for (const bad of ["plain text", "v2.a.b.c", "v1.only.two", ""]) expect(() => decryptSecret(bad, "key"), bad).toThrow("not an encrypted secret")
    })
})
