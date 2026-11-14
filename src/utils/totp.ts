import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * The 6-digit codes of an authenticator app (TOTP, RFC 6238: HMAC-SHA1, a new code every
 * 30 seconds). The app and the server share a secret and a clock and each work the code
 * out alone; nothing is sent between them.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"   // base32, the form authenticator apps take a secret in
const STEP_MS = 30_000

/** A new 160-bit secret, in base32. 256 is a multiple of 32, so every letter is equally likely. */
export const newTotpSecret = (): string => Array.from(randomBytes(32), (byte) => ALPHABET[byte & 31]).join("")

function base32Decode(text: string): Buffer {
    let bits = ""
    for (const letter of text) bits += ALPHABET.indexOf(letter).toString(2).padStart(5, "0")
    return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))
}

/** The code for one 30-second step (the number of steps since 1970). */
export function totpCode(secret: string, step: number, digits = 6): string {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest()
    const offset = mac[mac.length - 1]! & 0xf
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0")
}

export const totpStep = (now = Date.now()): number => Math.floor(now / STEP_MS)

/**
 * The step `code` belongs to, or null when it is wrong. The step before and after count
 * too, for a phone whose clock is a little off and a code typed just as it changed.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
    const typed = code.replace(/\s/g, "")
    if (!/^\d{6}$/.test(typed)) return null
    const current = totpStep(now)
    for (const step of [current, current - 1, current + 1]) {
        if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(typed))) return step
    }
    return null
}

/** What the setup QR code holds: the secret, and the names the app lists it under. */
export function otpauthUri(secret: string, account: string, issuer = "Summit Portal"): string {
    return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
}
