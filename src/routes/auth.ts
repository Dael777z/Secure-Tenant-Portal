import { Router, type Response } from "express"

import type { AppConfig } from "../config"
import { permissionsByRole, type Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import type { AuthService } from "../services/auth"
import { AppError } from "../types/errors"
import type { ValidRequest } from "../types/access"

/**
 * /api/auth: sign-up, sign-in and sessions, kept in two httpOnly cookies.
 *
 *   POST /auth/signup    { token, password }   an invited tenant chooses a password
 *   POST /auth/login     { email, password }   sets both cookies
 *   POST /auth/refresh                         swaps the refresh cookie for a new pair
 *   POST /auth/logout                          revokes the refresh token, clears both
 *   GET  /auth/me                              who is signed in, with permissions
 */
export function createAuthRouter(deps: { auth: AuthService; guard: Auth; config: AppConfig; limits: RateLimits }): Router {
    const { auth, guard, config, limits } = deps
    const router = Router()

    const access = { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/" }
    const refresh = { ...access, sameSite: "strict" as const }
    const setCookies = (res: Response, session: { accessToken: string; refreshToken: string }) => {
        res.cookie("access_token", session.accessToken, { ...access, maxAge: config.accessTtlSeconds * 1000 })
        res.cookie("refresh_token", session.refreshToken, { ...refresh, maxAge: config.refreshTtlMilliseconds })
    }
    const strings = (...values: unknown[]) => {
        if (!values.every((v) => typeof v === "string")) throw new AppError("VALIDATION_ERROR")
        return values as string[]
    }

    router.post("/auth/signup", limits.signup, async (req, res) => {
        const [token, password] = strings(req.body?.token, req.body?.password)
        const user = await auth.signup(token!, password!)
        res.status(201).json({ id: user.id, email: user.email, role: user.role })
    })

    router.post("/auth/login", limits.login, async (req, res) => {
        const [email, password] = strings(req.body?.email, req.body?.password)
        const { user, ...session } = await auth.login(email!, password!)
        setCookies(res, session)
        res.json({ user: { user_id: user.id, email: user.email, role: user.role, permissions: permissionsByRole[user.role] } })
    })

    router.post("/auth/refresh", limits.refresh, async (req, res) => {
        const token = req.cookies?.refresh_token
        if (typeof token !== "string" || !token) throw new AppError("UNAUTHENTICATED")
        setCookies(res, await auth.refresh(token))
        res.json({ ok: true })
    })

    router.post("/auth/logout", async (req, res) => {
        const token = req.cookies?.refresh_token
        if (typeof token === "string" && token) await auth.logout(token)
        res.clearCookie("access_token", access)
        res.clearCookie("refresh_token", refresh)
        res.status(204).end()
    })

    router.get("/auth/me", guard.authenticate, (req: ValidRequest, res) => {
        const { id, role } = req.user!
        res.json({ user: { user_id: id, role, permissions: permissionsByRole[role] } })
    })

    return router
}
