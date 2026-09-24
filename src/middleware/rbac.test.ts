import { describe, expect, it } from "vitest"
import { requirePermission } from "./rbac"
import type { Role, ValidRequest } from "../types/interfaces"

function requestWithRole(role: Role): ValidRequest {
    return { user: { id: "user-1", role } } as ValidRequest
}

function responseDouble() {
    const response = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            response.statusCode = code
            return response
        },
        json(body: unknown) {
            response.body = body
            return response
        },
    }
    return response
}

describe("permission middleware", () => {
    it("allows a tenant to create their own payment", () => {
        const response = responseDouble()
        let continued = false

        requirePermission("payment:create:self")(
            requestWithRole("tenant"),
            response as never,
            () => { continued = true },
        )

        expect(continued).toBe(true)
        expect(response.statusCode).toBe(200)
    })

    it("denies a tenant access to system health", () => {
        const response = responseDouble()
        let continued = false

        requirePermission("system:health")(
            requestWithRole("tenant"),
            response as never,
            () => { continued = true },
        )

        expect(continued).toBe(false)
        expect(response.statusCode).toBe(403)
        expect(response.body).toEqual({ error: "Insufficient permissions" })
    })
})
