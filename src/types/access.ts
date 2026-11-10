import type { Request } from "express"

/**
 * Roles and permissions. The schema has two kinds of account, Tenants and
 * Admin. An Admin row's role is 'admin' (a property manager, full access) or
 * 'maintenance_staff' (the maintenance queue only, 003). What each may do is
 * `permissionsByRole` (middleware/auth.ts); the database enforces the same.
 */
export type Role = "admin" | "maintenance_staff" | "tenant"

/** The roles that live in the Admin table. */
export type StaffRole = Exclude<Role, "tenant">
export const isStaffRole = (role: string): role is StaffRole => role === "admin" || role === "maintenance_staff"

export type Permission =
    | "ledger:read:self"
    | "ledger:read:property"
    | "ledger:adjust"
    | "payment:create:self"
    | "maintenance:create"
    | "maintenance:manage"
    | "users:provision"
    | "messages:manage"
    | "messages:self"
    | "account:self"

/** A request after `authenticate`. `user.id` is "tenant:5" or "admin:3" (utils/user-id.ts). */
export interface ValidRequest extends Request {
    user?: { id: string; role: Role }
}

/**
 * What an access token must still agree with (012): the account's role today, and its token version, which the
 * database raises whenever the account is deactivated, has its sign-in reset, or changes role.
 */
export interface SessionState {
    role: Role
    tokenVersion: number
}
