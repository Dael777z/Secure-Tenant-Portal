import { Pool } from "pg"

/** A connection pool. One per process for the app; the CLI and tests make their own. */
export function createPool(connectionString: string): Pool {
    const pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    })
    // An idle connection dropped by Postgres (restart, reset) must not crash the process; the next query reconnects.
    pool.on("error", (error) => {
        console.error(`database connection lost: ${error.message}`)
    })
    return pool
}
