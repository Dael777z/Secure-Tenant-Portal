import type { Request } from "express"

/**
 * Roles and permissions. The schema has two kinds of account, Tenants and
 * Admin (whose role is only 'admin' for now). A narrower staff role would
 * widen that CHECK, be added here, and get a row in `permissionsByRole`
 * (middleware/auth.ts).
 */
export type Role = "admin" | "tenant"

export type Permission =
    | "ledger:read:self"
    | "ledger:read:property"
    | "ledger:adjust"
    | "payment:create:self"
    | "maintenance:create"
    | "maintenance:manage"
    | "users:provision"

/** A request after `authenticate`. `user.id` is "tenant:5" or "admin:3" (utils/user-id.ts). */
export interface ValidRequest extends Request {
    user?: { id: string; role: Role }
}
