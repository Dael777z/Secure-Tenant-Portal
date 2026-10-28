import { configDotenv } from "dotenv"

/**
 * All settings, in one object. Only what differs between machines comes from
 * the environment; everything else is a constant below (change those here,
 * in code review). Development needs no environment at all.
 *
 *   NODE_ENV               "production": secure cookies, strict rate limits, CSP/HSTS,
 *                          and the checks at the bottom. Otherwise development
 *                          (vitest sets "test" by itself).
 *   APP_DB_PASSWORD        the app's login (summit_app; row-level security applies)
 *   POSTGRES_PASSWORD      the schema owner, for `npm run db` only (migrate, seed, reset)
 *   DB_HOST, DB_PORT       where Postgres is (localhost:5432; "db" inside Docker)
 *   POSTGRES_USER/DB       owner login and database name (both "portal")
 *   DATABASE_URL, DATABASE_ADMIN_URL   full URLs instead of the above, for a Postgres elsewhere
 *   JWT_ACCESS_SECRET      required in production
 *   WEB_ORIGIN             where the browser loads the site from
 *   PORT, TRUST_PROXY_HOPS, LOG_FILE, PLAID_*, TOKEN_ENCRYPTION_KEY: optional
 *
 * The Docker and npm flows (scripts/portal.mjs) set these for you.
 */

/** Settings that are the same everywhere. */
const FIXED = {
    serviceName: "portal",
    /** "Today" for rent and leases is a date in this zone. */
    timeZone: "America/Denver",
    jwtIssuer: "portal",
    jwtAudience: "portal-web",
    accessTtlSeconds: 15 * 60,
    refreshTtlMilliseconds: 7 * 24 * 60 * 60 * 1000,
}

/** Requests per IP per 15 minutes. */
const RATE_LIMITS = {
    production: { login: 10, signup: 5, refresh: 20, sensitive: 10, messages: 60 },
    development: { login: 30, signup: 20, refresh: 60, sensitive: 30, messages: 200 },
    test: { login: 1000, signup: 1000, refresh: 1000, sensitive: 1000, messages: 1000 },
}

const DEV_ONLY_SECRET = "development-only-secret-never-use-in-production"
/** Development database passwords (the dev Postgres container uses the same defaults). */
const DEV_DB = { owner: "portal-dev-only", app: "summit-dev-only" }

export type Mode = keyof typeof RATE_LIMITS

/** `server: false` (the database CLI) skips the checks that only the web server needs. */
export function loadConfig(vars: NodeJS.ProcessEnv = process.env, { server = true } = {}) {
    const get = (name: string) => vars[name]?.trim() || ""
    const mode: Mode = get("NODE_ENV") === "production" ? "production" : get("NODE_ENV") === "test" ? "test" : "development"
    const production = mode === "production"
    const db = {
        host: get("DB_HOST") || "localhost",
        port: get("DB_PORT") || "5432",
        name: get("POSTGRES_DB") || "portal",
        owner: get("POSTGRES_USER") || "portal",
        ownerPassword: get("POSTGRES_PASSWORD") || (production ? "" : DEV_DB.owner),
        appPassword: get("APP_DB_PASSWORD") || (production ? "" : DEV_DB.app),
    }
    const webOrigin = get("WEB_ORIGIN") || "http://localhost:5173"
    const url = (user: string, password: string) =>
        password ? `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${db.host}:${db.port}/${encodeURIComponent(db.name)}` : ""

    const config = {
        ...FIXED,
        mode,
        production,
        port: Number(get("PORT") || 3000),
        webOrigin,
        secureCookies: production,
        trustProxyHops: Number(get("TRUST_PROXY_HOPS") || 0),
        accessSecret: get("JWT_ACCESS_SECRET") || (production ? "" : DEV_ONLY_SECRET),
        bcryptRounds: mode === "test" ? 4 : 12,
        rateLimits: RATE_LIMITS[mode],
        /** The app's login: summit_app, so row-level security applies. */
        databaseUrl: get("DATABASE_URL") || url("summit_app", db.appPassword),
        /** The schema owner: only `npm run db` uses it. */
        databaseAdminUrl: get("DATABASE_ADMIN_URL") || url(db.owner, db.ownerPassword),
        /** Also write JSON logs to this file (they always go to the console). */
        logFile: get("LOG_FILE"),
        /** Plaid is on when both keys are set. */
        plaidClientId: get("PLAID_CLIENT_ID"),
        plaidSecret: get("PLAID_SECRET"),
        plaidEnv: (get("PLAID_ENV") || "sandbox") as "sandbox" | "production",
        /** Where a bank's own sign-in page sends the tenant back to Link. Must be in the Plaid dashboard's allowed redirect URIs. */
        plaidRedirectUri: get("PLAID_REDIRECT_URI") || `${webOrigin.replace(/\/$/, "")}/plaid-oauth`,
        /** Encrypts Plaid access tokens at rest. */
        tokenEncryptionKey: get("TOKEN_ENCRYPTION_KEY") || (production ? "" : DEV_ONLY_SECRET),
    }

    const problems: string[] = []
    if (!Number.isInteger(config.port) || config.port <= 0) problems.push("PORT must be a port number")
    if (!Number.isInteger(config.trustProxyHops) || config.trustProxyHops < 0) problems.push("TRUST_PROXY_HOPS must be 0 or more")
    if (production && server) {
        if (config.accessSecret.length < 32) problems.push("JWT_ACCESS_SECRET must be set (32+ characters)")
        // http is fine only on this machine (browsers treat localhost as secure, so cookies still work).
        if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.webOrigin)) problems.push("WEB_ORIGIN must be an https:// address (or http://localhost)")
        if (config.plaidClientId && !config.tokenEncryptionKey) problems.push("TOKEN_ENCRYPTION_KEY must be set when Plaid is on")
    }
    if (server && config.plaidClientId) {
        if (config.plaidEnv !== "sandbox" && config.plaidEnv !== "production") problems.push("PLAID_ENV must be sandbox or production")
        // plaid's rules: https, no query or fragment; http only for localhost, and only in sandbox
        const redirect = config.plaidRedirectUri
        const localHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirect) && config.plaidEnv === "sandbox"
        if (/[?#]/.test(redirect) || !(redirect.startsWith("https://") || localHttp)) {
            problems.push("PLAID_REDIRECT_URI must be https:// (http://localhost only in sandbox), with no ? or #")
        }
    }
    if (problems.length) throw new Error(`Configuration problems:\n  - ${problems.join("\n  - ")}`)
    return config
}

export type AppConfig = ReturnType<typeof loadConfig>

/** Load .env (if there is one) and read the settings. */
export function configFromEnvironment(options?: { server?: boolean }): AppConfig {
    configDotenv({ quiet: true })
    return loadConfig(process.env, options)
}
