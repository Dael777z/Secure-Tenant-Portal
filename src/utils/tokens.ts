import jwt from "jsonwebtoken"
import crypto from "crypto"

import { env } from "../config/env"
import type { Role } from "../types/interfaces"

export function generateAccessToken(user_id: string, role: Role): string {
    return jwt.sign({sub: user_id, role }, env.accessSecret, { expiresIn: env.accessTtlSeconds })
}

export function generateRefreshToken(): {token: string, hash: string } {
    const token = crypto.randomBytes(64).toString("hex")
    const hash = crypto.createHash("sha256").update(token).digest("hex")
    return {token, hash}
}

export function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex")
}