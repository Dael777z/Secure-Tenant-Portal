import { env } from "../config/env"
import { LogService } from "../logging/log-service"
import { MemoryDatabase } from "../services/memory-db"
import { PostgresDatabase } from "../services/postgres-db"
import { createPool } from "../db/pool"
import type { Pool } from "pg"
import { TenantStore } from "../services/tenant-store"
import { createPlaidGateway, type PlaidGateway } from "../services/plaid"
import pino from "pino"
import { dirname } from "path"
import { mkdirSync } from "fs"

import type { DatabaseInterface } from "../types/interfaces"

let sharedPool: Pool | null = null
function pool(): Pool {
    sharedPool ??= createPool(env.databaseUrl)
    return sharedPool
}

export function createDatabase(): DatabaseInterface {
    if (env.databaseUrl) {
        return new PostgresDatabase(pool())
    }

    if (env.devMode) {
        return new MemoryDatabase()
    }

    throw new Error("DATABASE_URL is required when DEV is off")
}

export function createLogger(): LogService {
    const streams: pino.StreamEntry[] = []

    if (env.logConsoleEnabled) {
        streams.push({ stream: process.stdout })
    }

    if (env.logFileEnabled) {
        mkdirSync(dirname(env.logFilePath), { recursive: true })
        streams.push({ stream: pino.destination(env.logFilePath) })
    }

    if (streams.length === 0) {
        throw new Error("log output must be enabled")
    }

    const logger = pino({
        level: "info",
        base: {
            service: env.serviceName,
            environment: env.devMode ? "development" : "production",
        },
        redact: {
            paths: [
                "metadata.password",
                "metadata.password_h",
                "metadata.access_token",
                "metadata.refresh_token",
                "metadata.authorization",
                "metadata.cookie",
                "metadata.api_key",
                "metadata.card_number",
                "metadata.cvv",
                "metadata.error.stack",
            ],
            censor: "[REDACTED]",
        },
    }, pino.multistream(streams))

    return new LogService(logger)
}

/** The tenant pages' data store, when there is a database. */
export function createTenantStore(): TenantStore | null {
    if (!env.databaseUrl) return null
    return new TenantStore(pool(), { timeZone: process.env.PORTAL_TIMEZONE?.trim() || "America/Denver" })
}

/** Dael's Plaid link, when PLAID_CLIENT_ID and PLAID_SECRET are set. */
export function createPlaid(): PlaidGateway | null {
    if (!env.plaidClientId || !env.plaidSecret) return null
    return createPlaidGateway({ clientId: env.plaidClientId, secret: env.plaidSecret, env: env.plaidEnv })
}
