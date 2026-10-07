// npm run db:migrate  — apply db/migrations to DATABASE_URL.
// Run it as the database owner, not as the login the app uses day to day.
import { configDotenv } from "dotenv"
import { createPool } from "./pool"
import { MIGRATIONS_DIR, migrate } from "./migrate"

configDotenv()

async function main() {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new Error("Set DATABASE_URL in .env first (see .env.example).")
    const pool = createPool(url)
    try {
        const applied = await migrate(pool, MIGRATIONS_DIR, (message) => console.log(message))
        console.log(applied.length ? `done: ${applied.length} applied` : "already up to date")
    } finally {
        await pool.end()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
