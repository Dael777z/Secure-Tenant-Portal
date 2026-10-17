import bcrypt from "bcrypt"
import type { Pool } from "pg"

/**
 * The first staff account (or another one), created by `npm run db admin`.
 * This is how a production database gets a login without any sample data.
 * Runs as the schema owner, like the seed.
 */
export async function createStaffAccount(pool: Pool, input: { email: string; name: string; password: string; bcryptRounds: number }): Promise<void> {
    if (input.password.length < 8) throw new Error("The password must be at least 8 characters.")
    const passwordHash = await bcrypt.hash(input.password, input.bcryptRounds)
    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.user_type', 'system', true)")
        await client.query("INSERT INTO Admin (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')", [input.name, input.email.trim().toLowerCase(), passwordHash])
        await client.query("COMMIT")
    } catch (error) {
        await client.query("ROLLBACK")
        const code = (error as { code?: string }).code
        if (code === "23505") throw new Error(`${input.email} already has an account (staff or tenant).`)
        if (code === "23514") throw new Error(`${input.email} is not an email address.`)
        if (code === "42P01") throw new Error("The database has no tables yet. Run migrate first.")
        throw error
    } finally {
        client.release()
    }
}
