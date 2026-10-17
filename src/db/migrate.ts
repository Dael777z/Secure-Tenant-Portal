import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Pool } from "pg"

/**
 * Schema changes are the numbered files in db/migrations, applied in order,
 * once each, and recorded in `schema_migrations`. To change the schema, add
 * the next file (003_whatever.sql). Never edit a file that has been applied:
 * `migrate` refuses, because the database would no longer match its history.
 * (In development, `npm run db reset` starts over from the files.)
 */
export const MIGRATIONS_DIR = resolve(__dirname, "../../db/migrations")

/** Line endings do not count, so a Windows checkout matches a Linux one. */
const sha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")

function readMigrations(dir: string) {
    return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => {
        const sql = readFileSync(resolve(dir, name), "utf8")
        return { name, sql, checksum: sha256(sql) }
    })
}

/** What has been applied, what is waiting, and anything recorded that is no longer a file here. */
export async function migrationStatus(pool: Pool, dir = MIGRATIONS_DIR) {
    const files = readMigrations(dir)
    const exists = (await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok
    const done = new Map<string, string>(exists
        ? (await pool.query("SELECT filename, checksum FROM schema_migrations")).rows.map((r) => [r.filename, r.checksum])
        : [])
    return {
        applied: files.filter((f) => done.has(f.name)).map((f) => f.name),
        pending: files.filter((f) => !done.has(f.name)),
        changed: files.filter((f) => done.has(f.name) && done.get(f.name) !== f.checksum).map((f) => f.name),
        unknown: [...done.keys()].filter((name) => !files.some((f) => f.name === name)),
    }
}

/** Apply every pending migration. Run as the schema owner. Returns the names applied. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR, log: (line: string) => void = () => {}): Promise<string[]> {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    const { pending, changed, unknown } = await migrationStatus(pool, dir)
    if (changed.length || unknown.length) {
        throw new Error(
            `The database does not match db/migrations (${[...changed.map((n) => `${n} was edited`), ...unknown.map((n) => `${n} is not a file`)].join(", ")}).\n` +
            "Add a new migration instead of editing an old one; in development, `npm run db reset` starts over.")
    }

    const client = await pool.connect()
    try {
        for (const { name, sql, checksum } of pending) {
            // A file with its own BEGIN ... COMMIT (the dev's 001 has one) runs as written; others get a transaction here.
            const ownTransaction = /^\s*BEGIN\s*;/im.test(sql)
            try {
                if (!ownTransaction) await client.query("BEGIN")
                await client.query(sql)
                await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [name, checksum])
                if (!ownTransaction) await client.query("COMMIT")
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined)
                throw new Error(`${name} failed: ${(error as Error).message}`)
            }
            log(`applied ${name}`)
        }
        // The app checks this at startup (see checkDatabase), so its login may read it.
        await client.query("GRANT SELECT ON schema_migrations TO summit_app")
    } finally {
        client.release()
    }
    return pending.map((m) => m.name)
}

/**
 * Give `summit_app` (created by 001 without a login) the password in
 * DATABASE_URL, so the app can connect. Does nothing when DATABASE_URL uses
 * another login. Run as the owner, after migrating.
 */
export async function setAppLogin(pool: Pool, databaseUrl: string): Promise<boolean> {
    if (!databaseUrl) return false
    const url = new URL(databaseUrl)
    if (decodeURIComponent(url.username) !== "summit_app" || !url.password) return false
    const { rows } = await pool.query("SELECT format('ALTER ROLE summit_app LOGIN PASSWORD %L', $1::text) AS sql", [decodeURIComponent(url.password)])
    await pool.query(rows[0].sql)
    return true
}

/** Development only: drop everything in the database's public schema, ready to migrate from scratch. */
export async function wipe(pool: Pool): Promise<void> {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
}

/**
 * Run by the server at startup, as the app's own login: can it connect, and
 * is the schema up to date? Turns the usual first-run failures into one line
 * that says what to run.
 */
export async function checkDatabase(pool: Pool, dir = MIGRATIONS_DIR): Promise<void> {
    let applied: string[]
    try {
        applied = (await pool.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
    } catch (error) {
        const e = error as { code?: string; message: string }
        if (e.code === "42P01") throw new Error("The database has no tables yet. Run: npm run db setup")
        if (e.code === "28P01" || e.code === "28000") throw new Error("summit_app could not sign in to Postgres. Run `npm run db migrate` (it sets summit_app's password to APP_DB_PASSWORD), or check APP_DB_PASSWORD.")
        if (e.code === "42501") throw new Error("This login cannot read schema_migrations. Run: npm run db migrate")
        if (e.code === "ECONNREFUSED") throw new Error("Postgres is not running at the DATABASE_URL address.")
        if (e.code === "3D000") throw new Error("The database in DATABASE_URL does not exist yet.")
        throw error
    }
    const pending = readMigrations(dir).map((m) => m.name).filter((name) => !applied.includes(name))
    if (pending.length) throw new Error(`The database is missing migrations: ${pending.join(", ")}. Run: npm run db migrate`)

    // Row-level security does not apply to the tables' owner or a superuser, so the app must not sign in as one.
    const { rows } = await pool.query(`
        SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user, c.relowner, 'USAGE') AS bypasses, current_user AS login
          FROM pg_roles r, pg_class c
         WHERE r.rolname = current_user AND c.oid = 'lease'::regclass`)
    if (rows[0]?.bypasses) {
        throw new Error(`The app signs in as ${rows[0].login}, which skips row-level security. It must use summit_app: ` +
            "remove DATABASE_URL from your environment (it is built from APP_DB_PASSWORD) or point it at summit_app.")
    }
}
