import type { NextFunction, Response } from "express"
import type { Permission, Role, ValidRequest } from "../types/interfaces"

export const permissionsByRole: Record<Role, readonly Permission[]> = {
    platform_admin: [
        "system:health",
        "ledger:read:self",
        "ledger:read:property",
        "ledger:adjust",
        "payment:create:self",
        "payment:review",
        "maintenance:create",
        "maintenance:manage",
        "notifications:send",
        "users:provision",
    ],
    property_manager: [
        "ledger:read:property",
        "ledger:adjust",
        "payment:review",
        "maintenance:manage",
        "notifications:send",
        "users:provision",
    ],
    maintenance_staff: ["maintenance:manage"],
    tenant: ["ledger:read:self", "payment:create:self", "maintenance:create"],
}

export const requirePermission = (permission: Permission) => {
    return (req: ValidRequest, res: Response, next: NextFunction): void => {
        const userRole = req.user?.role
        if (!userRole) {
            res.status(401).json({ error: "Not authenticated" })
            return undefined
        }

        if (!permissionsByRole[userRole].includes(permission)) {
            res.status(403).json({ error: "Insufficient permissions" })
            return
        }

        next()
    }
}