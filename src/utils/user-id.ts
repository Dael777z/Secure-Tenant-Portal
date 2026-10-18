import { AppError } from "../types/errors"

// Object that stores the user information from the JWT access token, a user_id attached to either the tenant or admin table
type Owner = { table: "tenant"; id: number } | { table: "admin"; id: number }

// takes a decrypted user string and matches the string to "(tenant|admin):Number" and returns an owner object
export function parseUserId(id: string): Owner | null {
    const match = /^(tenant|admin):([1-9][0-9]{0,9})$/.exec(id)
    if (!match) return null
    return { table: match[1] as "tenant" | "admin", id: Number(match[2]) }
}

// creates a user id string from a given id, called in context.
export const tenantId = (tID: number) => `tenant:${tID}`
export const adminId = (adminID: number) => `admin:${adminID}`

// check if user id string is a tenant, throw NOT_FOUND else return id.
export function tenantIdOf(userId: string): number {
    const owner = parseUserId(userId)
    if (!owner || owner.table !== "tenant") throw new AppError("NOT_FOUND")
    return owner.id
}
