// Every way to run Portal, behind the npm scripts in package.json:
//
//                  this machine        containers          Cloudflare Tunnel
//   development    npm run dev         npm run docker:dev   npm run cloudflare:dev
//   production     npm run prod        npm run docker:prod  npm run cloudflare:prod
//
//   npm run db <task>      the development database (status, migrate, admin, seed, setup, reset)
//   npm test               every test, on the development database (npm run test:unit: no database)
//
// Container and tunnel targets also take an action:
//   npm run docker:prod            start (or update) the stack
//   npm run docker:prod logs       follow the app's logs
//   npm run docker:prod status     list the containers
//   npm run docker:prod db admin you@example.com "Your Name"   add a staff login (asks for the password)
//   npm run docker:prod db seed    sample data, for a synthetic demo (asks first)
//   npm run docker:prod down       stop it (add "-- --volumes" to also delete its database)
//
// Development settings are optional (.env, see .env.example). Production settings live in
// .env.prod, created with random secrets the first time a production target runs.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface as createCallbackInterface } from "node:readline"
import { createInterface } from "node:readline/promises"
import dotenv from "dotenv"

const root = resolve(import.meta.dirname, "..")

const STACKS = {
    "docker:dev": { production: false },
    "docker:prod": { production: true },
    "cloudflare:dev": { production: false, tunnel: true },
    "cloudflare:prod": { production: true, tunnel: true },
}
const DEV_DB = { owner: "portal-dev-only", app: "summit-dev-only" }   // the same defaults as src/config.ts
const PORTS = { dev: 3000, prod: 8080, vite: 5173 }

const [command = "help", ...args] = process.argv.slice(2)

// ---- Helpers

function fail(message) {
    console.error(`\n  ${message}\n`)
    process.exit(1)
}

/** This process's environment plus `extra` (entries left undefined are dropped). */
const withEnv = (extra) => ({ ...process.env, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) })

/** Run a command in the foreground; stop everything if it fails. */
function run(cmd, cmdArgs, env = {}, { allowFailure = false } = {}) {
    const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env: withEnv(env) })
    if (result.error) fail(result.error.code === "ENOENT" ? `${cmd} is not installed or not on PATH.` : result.error.message)
    if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1)
    return result.status
}

/** The JS entry of a dev tool in node_modules, run with this same node (works the same on Windows). */
function bin(pkg) {
    const json = JSON.parse(readFileSync(resolve(root, "node_modules", pkg, "package.json"), "utf8"))
    const entry = typeof json.bin === "string" ? json.bin : json.bin[pkg] ?? Object.values(json.bin)[0]
    return resolve(root, "node_modules", pkg, entry)
}
const node = (pkg, toolArgs, env) => run(process.execPath, [bin(pkg), ...toolArgs], env)

function envFileFor(production) {
    return resolve(root, production ? ".env.prod" : ".env")
}

const readEnv = (file) => (existsSync(file) ? dotenv.parse(readFileSync(file)) : {})

/** Production needs real secrets. Create .env.prod with random ones, or add any that are missing. */
function ensureProductionEnv() {
    const file = envFileFor(true)
    const secret = () => randomBytes(24).toString("hex")
    if (!existsSync(file)) {
        writeFileSync(file, [
            "# Production settings (git-ignored). Created by scripts/portal.mjs with random secrets.",
            "# Keep this file private; if it is lost, the database passwords are lost with it.",
            `POSTGRES_PASSWORD=${secret()}`,
            `APP_DB_PASSWORD=${secret()}`,
            `JWT_ACCESS_SECRET=${secret()}`,
            `TOKEN_ENCRYPTION_KEY=${secret()}`,
            "",
            "# For npm run cloudflare:prod: the public address and the tunnel's token.",
            "# WEB_ORIGIN=https://portal.example.com",
            "# CLOUDFLARE_TUNNEL_TOKEN=",
            "",
            "# Plaid (bank linking). Without it, tenants cannot pay online in production.",
            "# PLAID_CLIENT_ID=",
            "# PLAID_SECRET=",
            "# PLAID_ENV=sandbox",
            "",
        ].join("\n"))
        console.log("  created .env.prod with new random secrets")
        return
    }
    const values = dotenv.parse(readFileSync(file))
    const missing = ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_ACCESS_SECRET", "TOKEN_ENCRYPTION_KEY"].filter((key) => !values[key])
    if (missing.length) {
        appendFileSync(file, `\n# Added by scripts/portal.mjs\n${missing.map((key) => `${key}=${secret()}`).join("\n")}\n`)
        console.log(`  added to .env.prod: ${missing.join(", ")}`)
    }
}

/** Ask for a password twice without echoing it. */
async function askPassword() {
    const ask = (question) => new Promise((done) => {
        const rl = createCallbackInterface({ input: process.stdin, output: process.stdout, terminal: true })
        rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text) }   // hide what is typed
        rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); done(answer) })
    })
    const password = await ask("  Password for the new staff login (8+ characters): ")
    if (password.length < 8) fail("The password must be at least 8 characters.")
    if ((await ask("  Same password again: ")) !== password) fail("The two passwords differ.")
    return password
}

async function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`  ${question} Type "yes" to continue: `)
    rl.close()
    return answer.trim().toLowerCase() === "yes"
}

async function waitForHealth(url, seconds = 90) {
    for (let i = 0; i < seconds; i++) {
        try {
            if ((await fetch(url)).ok) return true
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 1000))
    }
    return false
}

// ---- Containers

function compose(production, composeArgs, env = {}, options) {
    const file = envFileFor(production)
    return run("docker", [
        "compose",
        "-p", production ? "portal-prod" : "portal-dev",
        "-f", "compose.yaml", ...(production ? [] : ["-f", "compose.dev.yaml"]),
        ...(existsSync(file) ? ["--env-file", file] : []),
        ...composeArgs,
    ], env, options)
}

/** The development Postgres (a container), shared by npm run dev, npm run db, npm test and docker:dev. */
function startDevDatabase(env) {
    if (env.DATABASE_URL || env.DATABASE_ADMIN_URL) return   // using a Postgres somewhere else
    if (compose(false, ["up", "-d", "--wait", "db"], {}, { allowFailure: true }) !== 0) {
        fail("Could not start the development database container. Is Docker running? (Or set DATABASE_URL and DATABASE_ADMIN_URL in .env to use a Postgres elsewhere.)")
    }
}

async function stack(name, { production, tunnel }, action = "up", rest = []) {
    if (production) ensureProductionEnv()
    const env = readEnv(envFileFor(production))
    const port = Number(env.APP_PORT || (production ? PORTS.prod : PORTS.dev))
    const local = `http://localhost:${port}`

    // Settings that follow from the target, not from the file.
    const derived = {
        APP_PORT: String(port),
        WEB_ORIGIN: tunnel ? env.WEB_ORIGIN : local,
        TRUST_PROXY_HOPS: tunnel ? "1" : "0",
        // compose.yaml hands this to cloudflared as a secret file, not an environment variable.
        CLOUDFLARE_TUNNEL_TOKEN: tunnel ? env.CLOUDFLARE_TUNNEL_TOKEN : undefined,
    }
    const all = ["--profile", "cloudflare"]

    switch (action) {
        case "up": {
            if (tunnel && (!env.CLOUDFLARE_TUNNEL_TOKEN || !/^https:\/\//.test(env.WEB_ORIGIN ?? ""))) {
                fail(`${name} needs CLOUDFLARE_TUNNEL_TOKEN and WEB_ORIGIN=https://<your hostname> in ${production ? ".env.prod" : ".env"} (see README, "Cloudflare").`)
            }
            compose(production, ["build"], derived)
            compose(production, ["run", "--rm", "migrate"], derived)
            compose(production, [...(tunnel ? ["--profile", "cloudflare"] : []), "up", "-d", "--remove-orphans", "app", ...(tunnel ? ["cloudflared"] : [])], derived)
            if (!tunnel) compose(production, [...all, "stop", "cloudflared"], derived, { allowFailure: true })
            if (!(await waitForHealth(`${local}/health/ready`))) fail(`The app did not become ready. See: npm run ${name} logs`)
            console.log(`\n  Portal (${production ? "production" : "development"}) is running at ${tunnel ? `${env.WEB_ORIGIN} (tunnel) and ` : ""}${local}`)
            console.log(`  Logs: npm run ${name} logs    Stop: npm run ${name} down\n`)
            return
        }
        case "down":
            return compose(production, [...all, "down", ...rest], derived)
        case "logs":
            return compose(production, [...all, "logs", "-f", "--tail", "200", ...(rest.length ? rest : ["app", ...(tunnel ? ["cloudflared"] : [])])], derived)
        case "status":
            return compose(production, [...all, "ps", "-a"], derived)
        case "db": {
            const [task = "help", ...flags] = rest
            if (task === "admin") {
                const password = process.env.ADMIN_PASSWORD ?? await askPassword()
                return compose(production, ["run", "--rm", "-e", "ADMIN_PASSWORD", "migrate", "node", "dist/server/cli.js", "admin", ...flags], { ...derived, ADMIN_PASSWORD: password })
            }
            const empty = flags.includes("empty")
            if (production && (task === "reset" || (task === "seed" && !empty))) {
                const what = task === "reset"
                    ? `deletes EVERYTHING in the PRODUCTION database${empty ? "" : " and loads sample data"}`
                    : "loads SAMPLE data into the PRODUCTION database (only for a synthetic demo)"
                if (!flags.includes("--yes") && !(await confirm(`\`${task}\` ${what}.`))) fail("Cancelled.")
                flags.push("--allow-production")
            }
            return compose(production, ["run", "--rm", "migrate", "node", "dist/server/cli.js", task, ...flags.filter((f) => f !== "--yes")], derived)
        }
        default:
            fail(`Unknown action "${action}". Use: up, down, logs, status, db <task>.`)
    }
}

// ---- This machine

/** Start child processes side by side with labelled output; stop all when one stops or on Ctrl+C. */
function together(processes) {
    const children = processes.map(({ label, cmd, cmdArgs, env }) => {
        const child = spawn(cmd, cmdArgs, { cwd: root, env: withEnv(env ?? {}), stdio: ["inherit", "pipe", "pipe"] })
        const prefix = (stream, out) => {
            let buffered = ""
            stream.on("data", (chunk) => {
                buffered += chunk
                const lines = buffered.split(/\r?\n/)
                buffered = lines.pop()
                for (const line of lines) out.write(`[${label}] ${line}\n`)
            })
        }
        prefix(child.stdout, process.stdout)
        prefix(child.stderr, process.stderr)
        return child
    })
    const stopAll = (code) => {
        for (const child of children) if (child.exitCode === null) child.kill()
        process.exitCode = code
    }
    for (const child of children) child.on("exit", (code) => stopAll(code ?? 0))
    process.on("SIGINT", () => stopAll(0))
    process.on("SIGTERM", () => stopAll(0))
}

function localDevelopment(flags) {
    const env = readEnv(envFileFor(false))
    startDevDatabase(env)
    node("tsx", ["src/cli.ts", "setup", ...flags])   // `npm run dev empty`: no sample data in a new database
    console.log(`\n  Portal (development): http://localhost:${PORTS.vite}  (API on :${env.PORT || PORTS.dev}; Ctrl+C stops)\n`)
    together([
        { label: "api", cmd: process.execPath, cmdArgs: [bin("tsx"), "watch", "src/app.ts"], env: { WEB_ORIGIN: `http://localhost:${PORTS.vite}` } },
        { label: "web", cmd: process.execPath, cmdArgs: [bin("vite"), "--config", "frontend/vite.config.mts"] },
    ])
}

/** The production build, run on this machine against the development database (migrated, never seeded). */
function localProduction() {
    const env = readEnv(envFileFor(false))
    startDevDatabase(env)
    node("tsx", ["src/cli.ts", "migrate"])
    run(process.execPath, [process.env.npm_execpath ?? fail("Run this through npm: npm run prod"), "run", "build"])
    const port = PORTS.prod
    console.log(`\n  Portal (production build, development data): http://localhost:${port}  (Ctrl+C stops)\n`)
    together([{
        label: "prod",
        cmd: process.execPath,
        cmdArgs: ["dist/server/app.js"],
        env: {
            NODE_ENV: "production",
            PORT: String(port),
            WEB_ORIGIN: `http://localhost:${port}`,
            APP_DB_PASSWORD: env.APP_DB_PASSWORD || DEV_DB.app,
            // A fresh secret each run: sessions end when it restarts, which is fine for a local check.
            JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET || randomBytes(24).toString("hex"),
        },
    }])
}

async function databaseTask(taskArgs) {
    const env = readEnv(envFileFor(false))
    if (taskArgs.length && taskArgs[0] !== "help") startDevDatabase(env)
    const password = taskArgs[0] === "admin" ? process.env.ADMIN_PASSWORD ?? await askPassword() : undefined
    node("tsx", ["src/cli.ts", ...taskArgs], { ADMIN_PASSWORD: password })
}

function tests(testArgs) {
    const env = readEnv(envFileFor(false))
    startDevDatabase(env)
    const owner = encodeURIComponent(env.POSTGRES_USER || "portal")
    const password = encodeURIComponent(env.POSTGRES_PASSWORD || DEV_DB.owner)
    const url = env.TEST_DATABASE_URL || `postgres://${owner}:${password}@${env.DB_HOST || "localhost"}:${env.DB_PORT || 5432}/postgres`
    node("vitest", ["run", ...testArgs], { TEST_DATABASE_URL: url })
}

// ---- Main

if (STACKS[command]) await stack(command, STACKS[command], args[0], args.slice(1))
else if (command === "dev") localDevelopment(args)
else if (command === "prod") localProduction()
else if (command === "db") await databaseTask(args)
else if (command === "test") tests(args)
else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\nimport ")[0].replace(/^\/\/ ?/gm, ""))
}
