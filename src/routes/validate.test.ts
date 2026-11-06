import { describe, expect, it } from "vitest"

import { date, email, id, idempotencyKey, money, person, RECEIPT_MAX_BYTES, receipt, text } from "./validate"

const code = (work: () => unknown) => {
    try { work() } catch (error) { return (error as { code?: string }).code }
    return undefined
}
const withHeader = (header: number[] | string, size = 64) => {
    const data = Buffer.alloc(size)
    ;(typeof header === "string" ? Buffer.from(header, "latin1") : Buffer.from(header)).copy(data)
    return data
}
const asReceipt = (data: Buffer, filename = "r.pdf") => ({ filename, data: data.toString("base64") })

describe("text", () => {
    it("trims, and measures the length after trimming", () => {
        expect(text("  hello  ", 5)).toBe("hello")
        expect(code(() => text("abcdef", 5))).toBe("VALIDATION_ERROR")
    })
    it("refuses blank values and non-strings", () => {
        for (const bad of ["", "   ", undefined, null, 5, {}, ["a"]]) expect(code(() => text(bad, 10)), String(bad)).toBe("VALIDATION_ERROR")
    })
    it("optional: nothing given is null, but spaces only are still refused", () => {
        for (const empty of [undefined, null, ""]) expect(text(empty, 10, { optional: true })).toBeNull()
        expect(code(() => text("   ", 10, { optional: true }))).toBe("VALIDATION_ERROR")
    })
})

describe("money", () => {
    it("accepts positive amounts up to $100,000", () => {
        for (const ok of [0.01, 1, 1200, 1234.56, 1450.5, 99999.99, 100000]) expect(money(ok), String(ok)).toBe(ok)
    })
    it("refuses zero, negatives, too much, fractions of a cent and non-numbers", () => {
        for (const bad of [0, -5, 100000.01, 0.001, 1.005, NaN, Infinity, "12", null, undefined, {}]) {
            expect(code(() => money(bad)), String(bad)).toBe("VALIDATION_ERROR")
        }
    })
    it("accepts every amount in whole cents", () => {
        const refused: number[] = []
        for (let cents = 1; cents <= 200_000; cents++) if (code(() => money(cents / 100))) refused.push(cents / 100)
        expect(refused.slice(0, 5)).toEqual([])
    })
})

describe("date", () => {
    it("accepts YYYY-MM-DD", () => {
        expect(date("2026-10-24")).toBe("2026-10-24")
        expect(date("2028-02-29")).toBe("2028-02-29")   // a leap day
        expect(date("2026-12-31")).toBe("2026-12-31")
    })
    it("refuses other shapes and months or days out of range", () => {
        for (const bad of ["2026-2-3", "2026-10-24T00:00", "24/10/2026", "2026-13-01", "2026-00-10", "2026-10-32", 20261024, null, undefined]) {
            expect(code(() => date(bad)), String(bad)).toBe("VALIDATION_ERROR")
        }
    })
    it("optional: nothing given is null", () => {
        expect(date(undefined, { optional: true })).toBeNull()
        expect(date("", { optional: true })).toBeNull()
    })
    it("refuses a day that does not exist (2026-02-30, 2026-02-29, 2026-04-31)", () => {
        for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31"]) expect(code(() => date(bad)), bad).toBe("VALIDATION_ERROR")
    })
})

describe("id", () => {
    it("takes a positive integer from a number or a URL parameter", () => {
        expect(id(12)).toBe(12)
        expect(id("12")).toBe(12)
        expect(id(2_000_000_000)).toBe(2_000_000_000)
    })
    it("refuses zero, negatives, fractions, text, blanks and anything past the database's integer", () => {
        for (const bad of [0, -1, 1.5, "0", "-1", "1.5", "abc", "12abc", "", null, undefined, 2_000_000_001, {}]) {
            expect(code(() => id(bad)), String(bad)).toBe("VALIDATION_ERROR")
        }
    })
})

describe("email and person", () => {
    it("lower-cases and trims", () => expect(email("  Pat@Example.COM ")).toBe("pat@example.com"))
    it("refuses things that are not an address", () => {
        for (const bad of ["pat", "pat@", "@example.com", "pat@example", "pat smith@example.com", "", 5, null]) {
            expect(code(() => email(bad)), String(bad)).toBe("VALIDATION_ERROR")
        }
    })
    it("a person needs a name and email; the phone is optional but capped at 20", () => {
        expect(person({ name: " Pat ", email: "PAT@x.io" })).toEqual({ name: "Pat", email: "pat@x.io", phone: null })
        expect(person({ name: "Pat", email: "pat@x.io", phone: "505-555-0100" }).phone).toBe("505-555-0100")
        expect(code(() => person({ name: "Pat", email: "pat@x.io", phone: "1".repeat(21) }))).toBe("VALIDATION_ERROR")
        expect(code(() => person(undefined))).toBe("VALIDATION_ERROR")
    })
})

describe("idempotencyKey", () => {
    it("is optional, and otherwise 8-64 letters, digits, - or _", () => {
        for (const none of [undefined, null, ""]) expect(idempotencyKey(none)).toBeNull()
        expect(idempotencyKey("3f2b8c1e-9d4a-4b7e-8c21-0a1b2c3d4e5f")).toBe("3f2b8c1e-9d4a-4b7e-8c21-0a1b2c3d4e5f")
        for (const bad of ["short", "has space in it", "semi;colon-key", "x".repeat(65), 12345678]) {
            expect(code(() => idempotencyKey(bad)), String(bad)).toBe("VALIDATION_ERROR")
        }
    })
})

describe("receipt: the file's own bytes decide its type, not what the browser claims", () => {
    const samples: Array<[string, Buffer]> = [
        ["image/jpeg", withHeader([0xff, 0xd8, 0xff, 0xe0])],
        ["image/png", withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)])],
        ["application/pdf", withHeader("%PDF-1.7")],
    ]
    it.each(samples)("recognises %s", (type, data) => {
        expect(receipt(asReceipt(data)).contentType).toBe(type)
    })
    it("refuses a program renamed to .png, and text", () => {
        expect(code(() => receipt(asReceipt(withHeader("MZ\u0090"), "photo.png")))).toBe("RECEIPT_INVALID")
        expect(code(() => receipt(asReceipt(Buffer.from("just some text"), "note.pdf")))).toBe("RECEIPT_INVALID")
    })
    it("allows exactly 4 MB and refuses one byte more", () => {
        const pdf = (size: number) => { const b = Buffer.alloc(size); b.write("%PDF-1.7"); return b }
        expect(receipt(asReceipt(pdf(RECEIPT_MAX_BYTES))).contentType).toBe("application/pdf")
        expect(code(() => receipt(asReceipt(pdf(RECEIPT_MAX_BYTES + 1))))).toBe("RECEIPT_INVALID")
    })
    it("refuses missing, empty, non-string and non-base64 data", () => {
        for (const bad of [undefined, null, {}, { data: "" }, { data: 5 }, { data: "not base64!!" }, { data: "JVBERi0=\nxx" }]) {
            expect(code(() => receipt(bad)), JSON.stringify(bad)).toBe("RECEIPT_INVALID")
        }
    })
    it("cleans the file name so it is safe in a header and on disk", () => {
        const pdf = withHeader("%PDF-1.7")
        const name = (filename: unknown) => receipt({ filename, data: pdf.toString("base64") }).filename
        expect(name("../../etc/passwd")).not.toMatch(/[/\\]/)
        expect(name('evil".pdf\r\nSet-Cookie: x=1')).toMatch(/^[A-Za-z0-9._ -]+$/)
        expect(name("x".repeat(500)).length).toBeLessThanOrEqual(120)
        expect(name(undefined)).toBe("receipt")
        expect(name("   ")).toBe("receipt")
    })
})
