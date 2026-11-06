import { createHash } from "node:crypto"

import type { UploadedFile } from "../types/additions"
import { AppError } from "../types/errors"

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export const DOCUMENT_TYPES = ["application/pdf", ...PHOTO_TYPES] as const
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/** What the bytes are, from their first few (never from the name or the browser's say-so). */
export function sniff(data: Buffer): string | null {
    if (data.length >= 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf"
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
    if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp"
    return null
}

/**
 * A file sent as JSON { filename, data } with data in base64. FILE_INVALID
 * when it is not one of `accept` (by its bytes) or not base64; FILE_TOO_LARGE
 * over `maxBytes`.
 */
export function readUpload(body: unknown, accept: readonly string[], maxBytes: number): UploadedFile {
    const { filename, data } = (body ?? {}) as { filename?: unknown; data?: unknown }
    if (typeof data !== "string" || data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError("FILE_INVALID")
    // Check the size before decoding, so a huge string is refused cheaply.
    if (Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) > maxBytes) throw new AppError("FILE_TOO_LARGE")
    const bytes = Buffer.from(data, "base64")
    if (bytes.length === 0) throw new AppError("FILE_INVALID")
    if (bytes.length > maxBytes) throw new AppError("FILE_TOO_LARGE")
    const contentType = sniff(bytes)
    if (!contentType || !accept.includes(contentType)) throw new AppError("FILE_INVALID")
    const name = typeof filename === "string" && filename.trim() ? filename.trim().replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) : "file"
    return { filename: name, contentType, data: bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}
