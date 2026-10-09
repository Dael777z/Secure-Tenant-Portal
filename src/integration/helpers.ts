import { Pool } from "pg"
import { MIGRATIONS_DIR, migrate } from "../db/migrate"

/**
 * Integration tests run against a real Postgres: TEST_DATABASE_URL in .env.
 * Without it they are skipped, so `npm test` still works with no database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || ""
export const hasDatabase = TEST_DATABASE_URL !== ""

/**
 * A pool on a schema of its own, freshly migrated. Each test file passes its
 * own name, so files can run at the same time without touching each other.
 */
export async function freshSchema(name: string): Promise<Pool> {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad schema name: ${name}`)
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
    try {
        await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
        await admin.query(`CREATE SCHEMA ${name}`)
    } finally {
        await admin.end()
    }
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5, options: `-c search_path=${name}` })
    await migrate(pool, MIGRATIONS_DIR)
    return pool
}

export async function dropSchema(pool: Pool, name: string): Promise<void> {
    await pool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
    await pool.end()
}
