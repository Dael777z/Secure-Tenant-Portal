import jwt from "jsonwebtoken"

import { env } from "../config/env"
import type { Response, NextFunction } from "express"
import type { Role, ValidRequest } from "../types/interfaces"

const roles = new Set<Role>(["platform_admin", "property_manager", "maintenance_staff", "tenant"])

export const authenticateJWT = (req: ValidRequest, res: Response, next: NextFunction) : void => {
    const token = req.cookies?.access_token

    if (typeof token !== "string" || !token) {
        res.status(401).json({ error: "Not authenticated"})
        return
    }
    
    try {
        const decoded = jwt.verify(token, env.accessSecret)
        if (typeof decoded !== "object" || decoded === null || typeof decoded.sub !== "string" || !roles.has(decoded.role as Role)) {
            res.status(401).json({ error: "Invalid token claims" })
            return
        }
        req.user = { id: decoded.sub, role: decoded.role as Role }
        next()
    } catch {
        res.status(401).json({ error: "Invalid/Expired Token"})
    }
}
