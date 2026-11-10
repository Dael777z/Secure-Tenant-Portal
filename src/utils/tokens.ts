import { createHash, randomBytes } from "node:crypto"
import jwt from "jsonwebtoken"

import type { Role } from "../types/access"
import type { HashExpiry } from "../types/inputs"

export interface AccessTokenConfig {
    accessSecret: string
    jwtIssuer: string
    jwtAudience: string
    accessTtlSeconds: number
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The short-lived JWT in the access_token cookie. `ver` is the account's token version when it was issued (012);
 * `authenticate` refuses the token once the account's version has moved on.
 */
export function generateAccessToken(config: AccessTokenConfig, userId: string, role: Role, tokenVersion = 0): string {
    return jwt.sign({ sub: userId, role, ver: tokenVersion }, config.accessSecret, {
        algorithm: "HS256",
        audience: config.jwtAudience,
        expiresIn: config.accessTtlSeconds,
        issuer: config.jwtIssuer,
    })
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

// generates a random token and it's hash
export function randomToken(): { token: string; hash: string } {
    const token = randomBytes(64).toString("hex")
    return { token, hash: hashToken(token) }
}

// generate a random token and attach a expirary to it
export function newInvite(): { token: string; hash: HashExpiry  } {
    const { token, hash } = randomToken()
    return { token, hash: { tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } }
}
