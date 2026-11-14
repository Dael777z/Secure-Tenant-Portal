import { describe, expect, it } from "vitest"
import { newTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from "./totp"

// RFC 6238, appendix B: the SHA-1 secret "12345678901234567890", in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

describe("totp", () => {
    it("matches the RFC 6238 test vectors", () => {
        const vectors: Array<[number, string]> = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]]
        for (const [seconds, code] of vectors) expect(totpCode(RFC_SECRET, totpStep(seconds * 1000), 8), String(seconds)).toBe(code)
    })

    it("accepts the current code and its neighbours, and says which step it was", () => {
        const now = 1234567890_000
        const step = totpStep(now)
        expect(verifyTotp(RFC_SECRET, "005924", now)).toBe(step)
        expect(verifyTotp(RFC_SECRET, " 005 924 ", now)).toBe(step)   // typed with spaces, as apps show it
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1)
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1)
    })

    it("refuses an old code, a wrong one and anything that is not six digits", () => {
        const now = 1234567890_000
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, totpStep(now) - 2), now)).toBeNull()
        expect(verifyTotp(RFC_SECRET, "000000", now)).toBeNull()
        for (const bad of ["", "12345", "1234567", "abcdef", "00592x"]) expect(verifyTotp(RFC_SECRET, bad, now), bad).toBeNull()
    })

    it("makes a different 160-bit base32 secret each time, and a link an authenticator app can open", () => {
        const secret = newTotpSecret()
        expect(secret).toMatch(/^[A-Z2-7]{32}$/)
        expect(newTotpSecret()).not.toBe(secret)
        expect(verifyTotp(secret, totpCode(secret, totpStep()))).toBe(totpStep())
        expect(otpauthUri(secret, "boss@example.com")).toBe(`otpauth://totp/Summit%20Portal%3Aboss%40example.com?secret=${secret}&issuer=Summit%20Portal`)
    })
})
