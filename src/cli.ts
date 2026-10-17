import { Pool } from "pg"

import { configFromEnvironment } from "./config"
import { createStaffAccount } from "./db/admin"
import { createPool } from "./db/pool"
import { migrate, migrationStatus, setAppLogin, wipe } from "./db/migrate"
import { seed } from "./db/seed"

const HELP = `Database tasks, as the schema owner (POSTGRES_USER / POSTGRES_PASSWORD).

  status                 what is applied, what is pending, whether there is data
  migrate                apply pending migrations; give summit_app its password (APP_DB_PASSWORD)
  admin <email> [name]   add a staff login; the password comes from ADMIN_PASSWORD (npm asks for it)
  seed [clean]           load the sample data in src/db/seed/data.ts (skipped if staff exist)
  setup [clean|empty]    migrate, then seed (safe to repeat)
  reset [clean|empty]    wipe the database, then setup

  "clean" loads the small clean-start dataset instead of the full sample;
  "empty" loads nothing (then add a login with admin). With NODE_ENV=production,
  seed and reset need --allow-production (the npm scripts ask you first), and
  setup never seeds.

  npm run db <task>               the development database
  npm run docker:prod db <task>   inside a Docker stack (any docker:/cloudflare: target)
  node dist/server/cli.js <task>  a built copy`

async function main(command = "help", ...flags: string[]) {
    const config = configFromEnvironment({ server: false })
    const has = (word: string) => flags.includes(word) || flags.includes(`--${word}`)
    // Production only ever gets sample data from an explicit seed or reset.
    const loadSample = !has("empty") && !(config.production && command === "setup")
    if (!["status", "migrate", "admin", "seed", "setup", "reset"].includes(command)) return console.log(HELP)
    if (!config.databaseAdminUrl) throw new Error("No owner login for the database: set POSTGRES_PASSWORD (or DATABASE_ADMIN_URL).")
    if (config.production && (command === "reset" || (command === "seed" && loadSample)) && !has("allow-production")) {
        throw new Error(`\`${command}\` with NODE_ENV=production needs --allow-production.`)
    }

    if (command !== "status") await createDatabaseIfMissing(config.databaseAdminUrl)
    const pool = createPool(config.databaseAdminUrl)
    try {
        if (command === "status") return await printStatus(pool)
        if (command === "admin") {
            const [email, ...name] = flags.filter((f) => !f.startsWith("--"))
            const password = process.env.ADMIN_PASSWORD ?? ""
            if (!email) throw new Error("Usage: admin <email> [name]")
            if (!password) throw new Error("Set ADMIN_PASSWORD (npm run db admin asks for it).")
            await createStaffAccount(pool, { email, name: name.join(" ") || email.split("@")[0]!, password, bcryptRounds: config.bcryptRounds })
            return console.log(`staff login added: ${email.toLowerCase()}`)
        }
        if (command === "reset") {
            await wipe(pool)
            console.log("wiped")
        }
        if (command !== "seed") {
            const applied = await migrate(pool, undefined, console.log)
            if (!applied.length) console.log("migrations: up to date")
            if (await setAppLogin(pool, config.databaseUrl)) console.log("summit_app: password set (APP_DB_PASSWORD)")
        }
        if (command !== "migrate" && loadSample) {
            const report = await seed(pool, { dataset: has("clean") ? "clean" : "sample", webOrigin: config.webOrigin, bcryptRounds: config.bcryptRounds })
            report.forEach((line) => console.log(line))
        }
    } finally {
        await pool.end()
    }
}

async function printStatus(pool: Pool) {
    const s = await migrationStatus(pool)
    console.log(`applied: ${s.applied.join(", ") || "none"}`)
    console.log(`pending: ${s.pending.map((m) => m.name).join(", ") || "none"}`)
    if (s.changed.length || s.unknown.length) console.log(`out of step: ${[...s.changed, ...s.unknown].join(", ")} (npm run db reset)`)
    if (s.applied.length) {
        const staff = (await pool.query("SELECT count(*)::int AS n FROM Admin")).rows[0].n
        console.log(staff ? `data: ${staff} staff account(s)` : "data: empty (npm run db seed)")
    }
}

/** First run on a fresh Postgres: create the database named in the URL (Docker's image does this itself). */
async function createDatabaseIfMissing(url: string) {
    const name = decodeURIComponent(new URL(url).pathname.slice(1))
    const server = new URL(url)
    server.pathname = "/postgres"
    const pool = new Pool({ connectionString: server.toString(), max: 1 })
    try {
        const { rowCount } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])
        if (!rowCount) {
            await pool.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`)
            console.log(`created database ${name}`)
        }
    } catch (error) {
        // No access to the maintenance database: leave it to the connection below to report.
        if ((error as { code?: string }).code !== "3D000" && (error as { code?: string }).code !== "42501") throw error
    } finally {
        await pool.end()
    }
}

main(...process.argv.slice(2)).catch((error) => {
    const code = (error as { code?: string }).code
    const hint = code === "3D000" ? " (npm run db setup creates it)" : code === "ECONNREFUSED" ? " (is Postgres running at DATABASE_ADMIN_URL?)" : ""
    console.error((error instanceof Error ? error.message : String(error)) + hint)
    process.exit(1)
})
