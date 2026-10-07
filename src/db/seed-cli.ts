// npm run db:seed  — add a manager, a property, units and an invited tenant.
import { configDotenv } from "dotenv"
import { createPool } from "./pool"
import { seed } from "./seed"

configDotenv()

async function main() {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new Error("Set DATABASE_URL in .env first (see .env.example).")
    const adminPassword = process.env.SEED_ADMIN_PASSWORD?.trim()
    if (!adminPassword || adminPassword.length < 8) {
        throw new Error("Set SEED_ADMIN_PASSWORD in .env (8+ characters) for the seeded manager.")
    }
    const pool = createPool(url)
    try {
        console.log(await seed(pool, {
            adminEmail: process.env.SEED_ADMIN_EMAIL?.trim() || "manager@example.com",
            adminPassword,
            bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
        }))
    } finally {
        await pool.end()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
