import { Pool } from "pg"

import { loadConfig } from "../config"
import { MIGRATIONS_DIR, migrate, setAppLogin } from "../db/migrate"
import { PostgresDatabase } from "../db/postgres-db"

/**
 * Integration tests run against a real Postgres, because the interesting
 * behaviour (row-level security, append-only payments, overlap checks) lives
 * in the database. TEST_DATABASE_URL is a login that may create databases,
 * e.g. postgres://postgres:secret@localhost:5432/postgres. Without it the
 * integration tests are skipped, so `npm test` still works with no database.
 *
 * Each test file gets a database of its own, freshly migrated, so files can
 * run at the same time. (A schema per file, as before, is not enough now: the
 * migrations install roles, extensions and RLS that belong to a database.)
 */
export const TEST_ADMIN_URL = process.env.TEST_DATABASE_URL?.trim() || ""
export const hasDatabase = TEST_ADMIN_URL !== ""

function appRolePassword(): string {
    try {
        const url = new URL(loadConfig().databaseUrl)

        if (url.username === "summit_app" && url.password) return decodeURIComponent(url.password)

    } catch { /* no database login configured */}
    return "summit-app-test-only"
}
const APP_ROLE_PASSWORD = appRolePassword()

export interface TestDatabase {
    //  Connected as the schema's owner: Bypasses RLS. 
    owner: Pool
    // Connected as `summit_app`: Has RLS
    app: Pool
    // Database Dependency
    db: PostgresDatabase
    // Database connection URL
    appUrl: string
    drop(): Promise<void>
}

// Generates the database connection URL for a given user & password
function urlFor(base: string, database: string, login?: { user: string; password: string }): string {
    const url = new URL(base)
    url.pathname = `/${database}`
    if (login) {
        url.username = login.user
        url.password = login.password
    }
    return url.toString()
}

// drop database and reapply the schema (migrations) for tests database
export async function freshDatabase(name: string): Promise<TestDatabase> {
    // if database name is garbled, throw error
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad database name: ${name}`)
    
    // attempt admin connection
    const admin = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 })
    try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) // drop entire database
        await admin.query(`CREATE DATABASE ${name}`) // recreate database
    } finally {
        await admin.end() // end pool session
    }

    //  setup app login for tests
    const owner = new Pool({ connectionString: urlFor(TEST_ADMIN_URL, name), max: 3 }) 
    await migrate(owner, MIGRATIONS_DIR)
    const appUrl = urlFor(TEST_ADMIN_URL, name, { user: "summit_app", password: APP_ROLE_PASSWORD })
    // summit_app is one role for the whole server, and test files run in parallel: two
    // ALTER ROLEs at once fail with "tuple concurrently updated". Same password, so try again.
    for (let attempt = 1; ; attempt++) {
        try {
            await setAppLogin(owner, appUrl)
            break
        } catch (error) {
            if (attempt >= 5 || !/tuple concurrently updated/.test((error as Error).message)) throw error
            await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
        }
    }
    const app = new Pool({ connectionString: appUrl, max: 5 })

    // return test database object
    return {
        owner,
        app,
        appUrl,
        db: new PostgresDatabase(app),
        async drop() { //drop helper function during tests
            await app.end()
            await owner.end()
            const cleanup = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 })
            try {
                await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
            } finally {
                await cleanup.end()
            }
        },
    }
}
