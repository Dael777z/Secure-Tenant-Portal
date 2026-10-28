import { Pool } from "pg"

// create pool adapter that creeates a new pool from a connection string 
export function createPool(connectionString: string): Pool {
    const pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    })

    // log connection errors or disconnects instead of failing
    pool.on("error", (error) => {
        console.error(`database connection lost: ${error.message}`)
    })
    return pool
}
