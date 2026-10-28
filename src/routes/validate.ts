import { AppError } from "../types/errors"
import type { Receipt } from "../types/records"

/**
 * Request-body checks shared by the routes. Each one returns the cleaned
 * value or throws VALIDATION_ERROR (400), so a handler reads top to bottom:
 *
 *     const body = req.body as Record<string, unknown>
 *     await manager.saveProperty(null, { name: text(body.name, 255)!, address: text(body.address, 500)! })
 *
 * `text`/`date` return null (not an error) for a blank value when `optional`.
 */

export const text = (value: unknown, max: number, { optional = false } = {}): string | null => {
    if ((value === undefined || value === null || value === "") && optional) return null
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError("VALIDATION_ERROR")
    return value.trim()
}

/** A positive dollar amount with at most two decimals, up to $100,000. (The tolerance absorbs floating-point dust: 19.99 * 100 is 1998.9999999999998.) */
export const money = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        throw new AppError("VALIDATION_ERROR")
    }
    return value
}

/** YYYY-MM-DD, and a day that exists (not 2026-02-30). */
export const date = (value: unknown, { optional = false } = {}): string | null => {
    if ((value === undefined || value === null || value === "") && optional) return null
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new AppError("VALIDATION_ERROR")
    return value
}

/** A database id, from a URL parameter ("12") or a JSON number. */
export const id = (value: unknown): number => {
    const n = typeof value === "string" ? Number(value) : value
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 2_000_000_000) throw new AppError("VALIDATION_ERROR")
    return n
}

export const email = (value: unknown): string => {
    const v = text(value, 255)!.toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new AppError("VALIDATION_ERROR")
    return v
}

/** { name, email, phone? } */
export const person = (value: unknown) => {
    const v = (value ?? {}) as Record<string, unknown>
    return { name: text(v.name, 255)!, email: email(v.email), phone: text(v.phone, 20, { optional: true }) }
}

/** Receipt types, recognised by their first bytes (the browser's stated type is not trusted alone). */
const RECEIPT_TYPES: Array<{ type: Receipt["contentType"]; matches: (b: Buffer) => boolean }> = [
    { type: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { type: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { type: "image/webp", matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
    { type: "application/pdf", matches: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
]
export const RECEIPT_MAX_BYTES = 4 * 1024 * 1024

/** { filename, data (base64) } → a checked receipt, or RECEIPT_INVALID. */
export const receipt = (value: unknown): Receipt => {
    const v = (value ?? {}) as Record<string, unknown>
    if (typeof v.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) throw new AppError("RECEIPT_INVALID")
    const data = Buffer.from(v.data, "base64")
    if (data.length === 0 || data.length > RECEIPT_MAX_BYTES) throw new AppError("RECEIPT_INVALID")
    const kind = RECEIPT_TYPES.find((t) => t.matches(data))
    if (!kind) throw new AppError("RECEIPT_INVALID")
    const name = typeof v.filename === "string" ? v.filename : ""
    const filename = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120).trim() || "receipt"
    return { filename, contentType: kind.type, data }
}

/** An optional client-made id for one checkout (a UUID or similar): 8 to 64 letters, digits, - or _. */
export const idempotencyKey = (value: unknown): string | null => {
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw new AppError("VALIDATION_ERROR")
    return value
}
