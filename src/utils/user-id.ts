import { AppError } from "../types/errors"

/**
 * Tenants and staff live in two tables, each with its own SERIAL id, so tenant
 * 5 and admin 5 are different people. The id the rest of the backend sees, and
 * that goes in the JWT, says which table it is: "tenant:5" or "admin:5".
 */
type Owner = { table: "tenant"; id: number } | { table: "admin"; id: number }

export function parseUserId(id: string): Owner | null {
    const match = /^(tenant|admin):([1-9][0-9]{0,9})$/.exec(id)
    if (!match) return null
    return { table: match[1] as "tenant" | "admin", id: Number(match[2]) }
}

export const tenantId = (tID: number) => `tenant:${tID}`
export const adminId = (adminID: number) => `admin:${adminID}`

export function tenantIdOf(userId: string): number {
    const owner = parseUserId(userId)
    if (!owner || owner.table !== "tenant") throw new AppError("NOT_FOUND")
    return owner.id
}
