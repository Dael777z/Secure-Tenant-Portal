import crypto from "crypto"

/**
 * Encrypt a secret before it goes in the database (Plaid access tokens).
 * AES-256-GCM: the stored value is "v1.<iv>.<tag>.<ciphertext>", base64url.
 * Someone with a copy of the database but not the key cannot use the token.
 */
function keyFrom(secret: string): Buffer {
    return crypto.createHash("sha256").update(`portal-token-key:${secret}`).digest()
}

export function encryptSecret(plain: string, secret: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv)
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".")
}

export function decryptSecret(stored: string, secret: string): string {
    const [version, iv, tag, data] = stored.split(".")
    if (version !== "v1" || !iv || !tag || !data) throw new Error("not an encrypted secret")
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
}
