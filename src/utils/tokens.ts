import { createHash, randomBytes } from "node:crypto"
import jwt from "jsonwebtoken"

import type { Role } from "../types/access"
import type { InviteToken } from "../types/inputs"

export interface AccessTokenConfig {
    accessSecret: string
    jwtIssuer: string
    jwtAudience: string
    accessTtlSeconds: number
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The short-lived JWT in the access_token cookie. */
export function generateAccessToken(config: AccessTokenConfig, userId: string, role: Role): string {
    return jwt.sign({ sub: userId, role }, config.accessSecret, {
        algorithm: "HS256",
        audience: config.jwtAudience,
        expiresIn: config.accessTtlSeconds,
        issuer: config.jwtIssuer,
    })
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

/** A random secret for the user (refresh token, invite link) and the hash the database keeps instead. */
export function randomToken(): { token: string; hash: string } {
    const token = randomBytes(64).toString("hex")
    return { token, hash: hashToken(token) }
}

/** A week-long sign-up invitation: `token` goes in the link, `invite` in the database. */
export function newInvite(): { token: string; invite: InviteToken } {
    const { token, hash } = randomToken()
    return { token, invite: { tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) } }
}
