import type { Pool, PoolClient } from "pg"

import { currentIdentity, settingsFor, type Identity } from "./identity"

/**
 * Run `work` in one transaction as `as` (by default, whoever the current request
 * is for). The transaction starts by telling Postgres who is asking, so
 * row-level security applies to everything inside it. Shared by
 * PostgresDatabase and PostgresAdditions (009).
 */
export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, as: Identity = currentIdentity()): Promise<T> {
    const client = await pool.connect()
    let broken = false
    try {
        await client.query("BEGIN")
        const [type, id, role] = settingsFor(as)
        // `true`: local to this transaction, so a pooled connection never carries an identity to the next caller.
        await client.query(
            "SELECT set_config('app.user_type', $1, true), set_config('app.user_id', $2, true), set_config('app.user_role', $3, true)",
            [type, id, role],
        )
        const result = await work(client)
        await client.query("COMMIT")
        return result
    } catch (error) {
        try { await client.query("ROLLBACK") } catch { broken = true }
        throw error
    } finally {
        client.release(broken)
    }
}
