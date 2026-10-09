import { Router } from "express"

import { env } from "../config/env"
import { authenticateJWT } from "../middleware/auth"
import { permissionsByRole, requirePermission } from "../middleware/rbac"
import { login, logout, refresh, signup } from "../services/auth"
import type { DatabaseInterface, ValidRequest } from "../types/interfaces"

export function createAuthRouter(db: DatabaseInterface): Router {
    const router = Router()
    const cookieOptions = {
        httpOnly: true,
        secure: env.secureCookies,
        sameSite: "lax" as const,
        path: "/",
    }

    router.post("/auth/signup", async (req, res) => {
        const { email, password } = req.body as { email?: unknown; password?: unknown }
        if (typeof email !== "string" || typeof password !== "string") {
            res.status(400).json({ error: "Email and password are required" })
            return
        }

        const user = await signup(db, email, password) 
        
        res.status(201).json({ id: user.id, email: user.email, role: user.role })
    })

    router.post("/auth/login", async (req, res) => {
        const { email, password } = req.body as { email?: unknown; password?: unknown }
        if (typeof email !== "string" || typeof password !== "string") {
            res.status(400).json({ error: "Email and password are required" })
            return
        }

        const result = await login(db, email, password)
        res.cookie("access_token", result.access_token, {
            ...cookieOptions,
            maxAge: env.accessTtlSeconds * 1000,
        })
        res.cookie("refresh_token", result.refresh_token, {
            ...cookieOptions,
            sameSite: "strict" as const,
            maxAge: env.refreshTtlMilliseconds,
        })
        res.json({
            user: {
                user_id: result.user.id,
                email: result.user.email,
                role: result.user.role,
                permissions: permissionsByRole[result.user.role],
            },
        })
    })

    router.post("/auth/refresh", async (req, res) => {
        const refresh_token = req.cookies?.refresh_token
        if (typeof refresh_token !== "string" || !refresh_token) {
            res.status(401).json({ error: "Not authenticated" })
            return
        }

        const result = await refresh(db, refresh_token)
        res.cookie("access_token", result.access_token, {
            ...cookieOptions,
            maxAge: env.accessTtlSeconds * 1000,
        })
        res.cookie("refresh_token", result.refresh_token, {
            ...cookieOptions,
            sameSite: "strict" as const,
            maxAge: env.refreshTtlMilliseconds,
        })
        res.json({ ok: true })
    })

    router.post("/auth/logout", async (req, res) => {
        const refresh_token = req.cookies?.refresh_token
        if (typeof refresh_token === "string" && refresh_token) {
            await logout(db, refresh_token)
        }

        res.clearCookie("access_token", cookieOptions)
        res.clearCookie("refresh_token", { ...cookieOptions, sameSite: "strict" as const })
        res.status(204).end()
    })

    router.get("/auth/me", authenticateJWT, (req: ValidRequest, res) => {
        const user = req.user
        if (!user) {
            res.status(401).json({ error: "Not authenticated" })
            return
        }

        res.json({
            user: {
                user_id: user.id,
                role: user.role,
                permissions: permissionsByRole[user.role],
            },
        })
    })

    router.get("/health", authenticateJWT, requirePermission("system:health"), (req: ValidRequest, res) => {
        res.json({ message: `Okay! Hello ${req.user?.role}` })
    })

    return router
}