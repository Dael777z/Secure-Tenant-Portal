import { describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret } from "./secrets"

describe("secret encryption (Plaid access tokens)", () => {
    it("round-trips, differs every time, and refuses the wrong key or a tampered value", () => {
        const a = encryptSecret("access-sandbox-123", "key one")
        const b = encryptSecret("access-sandbox-123", "key one")
        expect(a).not.toBe(b)
        expect(a).not.toContain("access-sandbox")
        expect(decryptSecret(a, "key one")).toBe("access-sandbox-123")
        expect(() => decryptSecret(a, "key two")).toThrow()
        const parts = a.split(".")
        parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "BB" : "AA")
        expect(() => decryptSecret(parts.join("."), "key one")).toThrow()
    })
})
