import bcrypt from "bcrypt"
import { env } from "../config/env"
import type { AuthStore } from "../types/interfaces"
import { AppError } from "../types/errors"
import { generateAccessToken, generateRefreshToken, hashToken } from "../utils/tokens"

export async function signup(db: AuthStore, email: string, password_r: string) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || password_r.length < 8) throw new AppError("VALIDATION_ERROR")

    const existing = await db.findUserByEmail(normalizedEmail)

    if (existing) throw new AppError("EMAIL_IN_USE")
    
    const password_h = await bcrypt.hash(password_r, env.bcryptRounds)

    return db.createUser({ email: normalizedEmail, password_h, role: "tenant"})
}

export async function login(db: AuthStore, email: string, password: string) {
    const user = await db.findUserByEmail(email.trim().toLowerCase())
    if (!user) throw new AppError("INVALID_CREDENTIALS")
    
    const match = await bcrypt.compare(password, user.password_h)
    if (!match) throw new AppError("INVALID_CREDENTIALS")

    const access_token = generateAccessToken(user.id, user.role)
    const { token: refresh_token, hash } = generateRefreshToken()

    await db.storeRefreshToken({
        user_id: user.id,
        token_h: hash,
        expiresAt: new Date(Date.now() + env.refreshTtlMilliseconds)
    })

    return {access_token, refresh_token, user}
}

export async function logout(db: AuthStore, incoming_token: string) {
    await db.revokeRefreshToken(hashToken(incoming_token))
}

export async function refresh(db: AuthStore, incoming_token: string) {
    const hash = hashToken(incoming_token)
    const stored = await db.findRefreshTokenByHash(hash)

    if (!stored || stored.revoked || stored.expiresAt.getTime() <= Date.now()) {
        throw new AppError("INVALID_TOKEN")
    }

    await db.revokeRefreshToken(hash)

    const user = await db.findUserByID(stored.user_id)
    if (!user) throw new AppError("USER_NOT_FOUND")
    
    const access_token = generateAccessToken(user.id, user.role)
    const {token: refresh_token, hash: new_h} = generateRefreshToken()

    await db.storeRefreshToken({
        user_id: user.id,
        token_h: new_h,
        expiresAt: new Date(Date.now() + env.refreshTtlMilliseconds)
    })

    return { access_token, refresh_token}
}