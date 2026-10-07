import crypto from "crypto"
import { readdir, readFile } from "fs/promises"
import path from "path"
import type { Pool } from "pg"

/**
 * Apply db/migrations/*.sql in filename order, each once, each in its own
 * transaction. A file that changed after it was applied stops the run: the
 * database would no longer match its own history.
 */
export async function migrate(pool: Pool, directory: string, log: (message: string) => void = () => {}) {
    const client = await pool.connect()
    const applied: string[] = []
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename    TEXT PRIMARY KEY,
                checksum    TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )`)
        const done = new Map(
            (await client.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM schema_migrations"))
                .rows.map((row) => [row.filename, row.checksum]),
        )
        const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()

        for (const file of files) {
            const sql = await readFile(path.join(directory, file), "utf8")
            const checksum = crypto.createHash("sha256").update(sql).digest("hex")
            const previous = done.get(file)
            if (previous) {
                if (previous !== checksum) {
                    throw new Error(`${file} changed after it was applied. Add a new migration instead of editing an old one.`)
                }
                continue
            }
            await client.query("BEGIN")
            try {
                await client.query(sql)
                await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [file, checksum])
                await client.query("COMMIT")
            } catch (error) {
                await client.query("ROLLBACK")
                throw new Error(`${file} failed: ${(error as Error).message}`)
            }
            applied.push(file)
            log(`applied ${file}`)
        }
        return applied
    } finally {
        client.release()
    }
}

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations")
