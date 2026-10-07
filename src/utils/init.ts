import { env } from "../config/env"
import { LogService } from "../logging/log-service"
import { MemoryDatabase } from "../services/memory-db"
import { PostgresDatabase } from "../services/postgres-db"
import { createPool } from "../db/pool"
import pino from "pino"
import { dirname } from "path"
import { mkdirSync } from "fs"

import type { DatabaseInterface } from "../types/interfaces"

export function createDatabase(): DatabaseInterface {
    if (env.databaseUrl) {
        return new PostgresDatabase(createPool(env.databaseUrl))
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