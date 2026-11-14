import { AsyncLocalStorage } from "node:async_hooks"

import { isStaffRole, type Role, type StaffRole } from "../types/access"
import { parseUserId } from "../utils/user-id"

/**
 * Who a database call is for. Row-level security reads three settings that
 * PostgresDatabase sets at the start of every transaction (app.user_type,
 * app.user_id, app.user_role); this holds the identity behind them, so store
 * methods never take it as a parameter.
 *
 *   admin      a staff member: role 'admin' (full access) or 'maintenance_staff' (the queue, 003)
 *   tenant     a tenant (their own lease, payments and requests)
 *   system     no person: the rent job, and writing a payment a tenant started
 *   anonymous  sign-in and sign-up; RLS shows nothing, only the auth_* functions work
 *
 * `authenticate` (middleware/auth.ts) sets it for a request; other code uses `runAs`.
 */


export type Identity =
    | { type: "admin"; id: number; role: StaffRole }
    | { type: "tenant"; id: number }
    | { type: "system" }
    | { type: "anonymous" }

export const SYSTEM: Identity = { type: "system" }
const ANONYMOUS: Identity = { type: "anonymous" }

const storage = new AsyncLocalStorage<Identity>()

// grabs the current ctx within the store, being the identity type.
export const currentIdentity = (): Identity => storage.getStore() ?? ANONYMOUS

// pass a function and an identity to the context worker (work sees ctx (identity) )
export const runAs = <T>(identity: Identity, work: () => T): T => storage.run(identity, work)

// return an identity from authentication claims
export function identityFromClaims(userId: string, role: Role): Identity {
    const owner = parseUserId(userId)
    if (!owner) return ANONYMOUS
    if (owner.table === "tenant") return role === "tenant" ? { type: "tenant", id: owner.id } : ANONYMOUS
    return isStaffRole(role) ? { type: "admin", id: owner.id, role } : ANONYMOUS
}

// returns the settings needed for RLS for each identity type, up to 3 user modes.
export function settingsFor(identity: Identity): [string, string, string] {
    switch (identity.type) {
        case "admin": return ["admin", String(identity.id), identity.role]
        case "tenant": return ["tenant", String(identity.id), ""]
        case "system": return ["system", "", ""]
        default: return ["", "", ""]
    }
}
