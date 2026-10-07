import { Pool } from "pg"

/**
 * One connection pool for the process. DATABASE_URL is a normal Postgres URL,
 * e.g. postgres://portal_app:secret@localhost:5432/portal
 */
export function createPool(connectionString: string): Pool {
    return new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    })
}
