import type { RequestHandler } from "express"
import jwt from "jsonwebtoken"

import { identityFromClaims, runAs } from "../db/identity"
import type { Permission, Role, ValidRequest } from "../types/access"
import { AppError } from "../types/errors"

export const permissionsByRole: Record<Role, readonly Permission[]> = {
    // A property manager.
    admin: ["ledger:read:property", "ledger:adjust", "maintenance:manage", "users:provision"],
    // On-site maintenance: the queue and nothing else (003's policies say the same in the database).
    maintenance_staff: ["maintenance:manage"],
    tenant: ["ledger:read:self", "payment:create:self", "maintenance:create"],
}

export interface JwtConfig {
    accessSecret: string
    jwtIssuer: string
    jwtAudience: string
}

/**
 * Route guards: `router.get("/path", ...guard.can("ledger:read:property"), handler)`.
 * `authenticate` verifies the access_token cookie, and the rest of the request
 * then runs as that user in the database too (row-level security sees who is asking).
 */
export function createAuth(config: JwtConfig) {
    const authenticate: RequestHandler = (req: ValidRequest, _res, next) => {
        const token = req.cookies?.access_token
        if (typeof token !== "string" || !token) throw new AppError("UNAUTHENTICATED")

        let claims: jwt.JwtPayload | string
        try {
            claims = jwt.verify(token, config.accessSecret, { algorithms: ["HS256"], audience: config.jwtAudience, issuer: config.jwtIssuer })
        } catch {
            throw new AppError("INVALID_TOKEN")
        }
        const role = typeof claims === "object" ? (claims.role as Role) : undefined
        if (typeof claims !== "object" || typeof claims.sub !== "string" || !role || !(role in permissionsByRole)) {
            throw new AppError("INVALID_TOKEN")
        }

        req.user = { id: claims.sub, role }
        runAs(identityFromClaims(claims.sub, role), next)
    }

    const allow = (permission: Permission): RequestHandler => (req: ValidRequest, _res, next) => {
        if (!permissionsByRole[req.user!.role].includes(permission)) throw new AppError("FORBIDDEN")
        next()
    }

    return { authenticate, can: (permission: Permission) => [authenticate, allow(permission)] }
}

export type Auth = ReturnType<typeof createAuth>
