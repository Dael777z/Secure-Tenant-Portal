import type { Request } from "express"
import { describe, expect, it } from "vitest"

import { AppError } from "../types/errors"
import { verifyRequestOrigin } from "./origin"

const WEB = "https://portal.example.com"
const run = (method: string, headers: Record<string, string>) => {
    const req = { method, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request
    let passed = false
    try { verifyRequestOrigin(WEB)(req, {} as never, () => { passed = true }) } catch (error) { if (!(error instanceof AppError)) throw error; return error.code }
    return passed ? "allowed" : "stopped"
}

describe("verifyRequestOrigin", () => {
    it("lets a write from our own page through, and writes from tools that send no browser headers", () => {
        expect(run("POST", { origin: WEB })).toBe("allowed")
        expect(run("POST", { origin: WEB, "sec-fetch-site": "same-origin" })).toBe("allowed")
        expect(run("DELETE", {})).toBe("allowed")
        expect(run("PUT", { "sec-fetch-site": "none" })).toBe("allowed")
    })

    it("refuses a write from another origin", () => {
        expect(run("POST", { origin: "https://evil.example" })).toBe("FORBIDDEN")
    })

    it("refuses a write the browser says came from another site or subdomain, even with no Origin header", () => {
        expect(run("POST", { "sec-fetch-site": "cross-site" })).toBe("FORBIDDEN")
        expect(run("PATCH", { "sec-fetch-site": "same-site" })).toBe("FORBIDDEN")
    })

    it("does not touch reads", () => {
        expect(run("GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe("allowed")
    })
})
