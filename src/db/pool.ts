import { Pool } from "pg"

/**
 * One connection pool for the process. DATABASE_URL is a normal Postgres URL,
 * e.g. postgres://portal_app:secret@localhost:5432/portal
 */
export function createPool(connectionString: string): Pool {
    const pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    })
    // An idle connection dropped by the server (Postgres restarted, demo reset)
    // must not crash the app; the pool opens a fresh one on the next query.
    pool.on("error", (error) => {
        console.error(`database connection lost: ${error.message}`)
    })
    return pool
}
