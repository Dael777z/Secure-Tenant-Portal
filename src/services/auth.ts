import bcrypt from "bcrypt"
import crypto from "crypto"
import { env } from "../config/env"
import type { AuthStore } from "../types/interfaces"
import { AppError } from "../types/errors"
import { generateAccessToken, generateRefreshToken, hashToken } from "../utils/tokens"

// Sign-up is for tenants the office has already added (agreed 10/1): the
// tenant row exists with no password, and signing up sets one. An address that
// was never invited, or has already signed up, gets the same answer either way.
export async function signup(db: AuthStore, email: string, password_r: string) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || password_r.length < 8) throw new AppError("VALIDATION_ERROR")

    // Hash first, so the response takes the same time whether or not there is an invitation.
    const password_h = await bcrypt.hash(password_r, env.bcryptRounds)

    const user = await db.completeSignup(normalizedEmail, password_h)
    if (!user) throw new AppError("SIGNUP_NOT_ALLOWED")
    return user
}

// A real bcrypt hash of a random value, compared against when the email is
// unknown, so an unknown address takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), env.bcryptRounds)

export async function login(db: AuthStore, email: string, password: string) {
    const user = await db.findUserByEmail(email.trim().toLowerCase())
    if (!user) {
        await bcrypt.compare(password, DUMMY_HASH)
        throw new AppError("INVALID_CREDENTIALS")
    }
    
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