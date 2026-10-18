import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Pool } from "pg"

// resolves the db migrations folder within dist or source
export const MIGRATIONS_DIR = resolve(__dirname, "../../db/migrations")

// hash the file contents normalizing line endings.
const sha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")

// returns a list of file data containing their hash, sql contents, and name.
function readMigrations(dir: string) {
    // filter contents for .sql files, sort them, and map each by file name into file data tuples.
    return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => {
        const sql = readFileSync(resolve(dir, name), "utf8")
        return { name, sql, checksum: sha256(sql) }
    })
}

// returns an object with 3 lists of file names detailing whether that migration is applied, changed, or pending.
export async function migrationStatus(pool: Pool, dir = MIGRATIONS_DIR) {

    const files = readMigrations(dir) // read .sql schema files in order

    // if schema migrations is not null, schema already executed
    const exists = (await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok

    // if schema exists, list every file checksum from the schema migrations table
    const old_checksums = new Map<string, string>(exists
        ? (await pool.query("SELECT filename, checksum FROM schema_migrations")).rows.map((r) => [r.filename, r.checksum])
        : [])
    
    // check old checksums against the current checksums, listing them by applied (up to date), changed (exists, out of date), pending (no schema entry)
    return {
        applied: files.filter((file) => old_checksums.has(file.name) && old_checksums.get(file.name) == file.checksum),
        changed: files.filter((file) => old_checksums.has(file.name) && old_checksums.get(file.name) != file.checksum),
        pending: files.filter((file) => !old_checksums.has(file.name))
    }
}



export async function migrate(pool: Pool, dir = MIGRATIONS_DIR, log: (line: string) => void = () => {}): Promise<string[]> {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)

    const { pending, changed } = await migrationStatus(pool, dir)

    if (changed.length) {
        throw new Error(
            `The database does not match db/migrations (${changed.map((file) => `${file.name} was edited`).join(", ")}).\n` +
            "`npm run db reset` starts over.")
    }

    const client = await pool.connect()

    try {
        for (const { name, sql, checksum } of pending) {
            // if the .sql file does its own transaction return true else false
            const ownTransaction = /^\s*BEGIN\s*;/im.test(sql)

            try {
                if (!ownTransaction) await client.query("BEGIN") // if .sql file does not has a transaction, begin one

                // execute the sql within the .sql file
                await client.query(sql)

                // insert the updated checksum into the schema migrations table
                await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [name, checksum])

                if (!ownTransaction) await client.query("COMMIT") // end the transaction if one was started
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined) // rollback database if you encounter an error
                throw new Error(`${name} failed: ${(error as Error).message}`) // print file name & error message
            }

            log(`applied ${name}`) // log the migrations applied fully
        }
        
        // Grant the app permission to select rows on the schema_migrations table
        await client.query("GRANT SELECT ON schema_migrations TO summit_app")
    } finally {
        client.release() // end connection
    }

    return pending.map((m) => m.name) // return the names of .sql files that were pending
}

// setups the app database account
export async function setAppLogin(pool: Pool, databaseUrl: string): Promise<boolean> {

    if (!databaseUrl) return false // if no database uri return false

    const url = new URL(databaseUrl) // turn string into url object

    // only accept the hard coded user/role and make sure a password is specified
    if (decodeURIComponent(url.username) !== "summit_app" || !url.password) return false

    // query the postgres sql to generate the alter role script with the uri passworld specified
    const { rows } = await pool.query("SELECT format('ALTER ROLE summit_app LOGIN PASSWORD %L', $1::text) AS sql", [decodeURIComponent(url.password)])
    await pool.query(rows[0].sql) // execute returned sql
    return true
}

// wipe the entire database, completely clean.
export async function wipe(pool: Pool): Promise<void> {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
}

export async function checkDatabase(pool: Pool, dir = MIGRATIONS_DIR): Promise<void> {
    let applied: string[]

    // check postgres sql errors by attempting to access schema_migrations
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
    const pending = readMigrations(dir).map((file) => file.name).filter((file_name) => !applied.includes(file_name))
    if (pending.length) throw new Error(`The database is missing migrations: ${pending.join(", ")}. Run: npm run db migrate`)

   // check the current user is the specified summit_app superuser
    const { rows } = await pool.query("SELECT current_user AS login")

    if (rows[0]?.login !== "summit_app") {
        throw new Error(
            `The app signs in as ${rows[0]?.login}, but must use summit_app. ` +
            "Check DATABASE_URL and APP_DB_PASSWORD."
        )
    }
}
