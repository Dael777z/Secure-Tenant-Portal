import type { RequestHandler } from "express"
import jwt from "jsonwebtoken"

import { identityFromClaims, runAs } from "../db/identity"
import type { Permission, Role, ValidRequest } from "../types/access"
import { AppError } from "../types/errors"

export const permissionsByRole: Record<Role, readonly Permission[]> = {
    // A property manager: full access.
    admin: ["ledger:read:property", "ledger:adjust", "maintenance:manage", "users:provision", "messages:manage"],
    // On-site maintenance: the queue and nothing else (003's policies say the same in the database).
    maintenance_staff: ["maintenance:manage"],
    tenant: ["ledger:read:self", "payment:create:self", "maintenance:create", "messages:self"],
}

export interface JwtConfig {
    accessSecret: string
    jwtIssuer: string
    jwtAudience: string
}

// creates auth/guard middleware
export function createAuth(config: JwtConfig) {
    
    //jwt middleware
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
        runAs(identityFromClaims(claims.sub, role), next) // run the following middleware with the async local storage context of being attached to this user
    }

    //rbac middleware, take a valid request (JWT authenticated) and check the attached user object against the permissions given as a parameter
    const allow = (permission: Permission): RequestHandler => (req: ValidRequest, _res, next) => {
        if (!permissionsByRole[req.user!.role].includes(permission)) throw new AppError("FORBIDDEN")
        next()
    }

    // return the auth/guard object instantiated at router creation, contains the can middleware combining the jwt & rbac middleware into one call
    return { authenticate, can: (permission: Permission) => [authenticate, allow(permission)] }
}

// Auth is the type of the tuple returned by the createAuth type/function, insane tech.
export type Auth = ReturnType<typeof createAuth>
