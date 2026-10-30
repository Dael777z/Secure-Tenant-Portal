import bcrypt from "bcrypt"
import type { Pool } from "pg"

// the function associated with the npm run db admin command, useful when you do not use seeding.
// `role`: 'maintenance_staff' for a maintenance login (npm run db admin <email> --maintenance).
export async function createStaffAccount(pool: Pool, input: { email: string; name: string; password: string; bcryptRounds: number; role?: "admin" | "maintenance_staff" }): Promise<void> {

    if (input.password.length < 8) throw new Error("The password must be at least 8 characters.")

    const passwordHash = await bcrypt.hash(input.password, input.bcryptRounds)
    const client = await pool.connect()

    // attempt to query the pool (database) and insert the seeded admin account
    // translates error codes into thrown errors with a message
    try {
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.user_type', 'system', true)") // Points RLS to the system user type
        await client.query("INSERT INTO Admin (name, email, password_hash, role) VALUES ($1, $2, $3, $4)", [input.name, input.email.trim().toLowerCase(), passwordHash, input.role ?? "admin"])
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
