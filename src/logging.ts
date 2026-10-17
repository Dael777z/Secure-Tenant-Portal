import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import pino, { type Logger } from "pino"

import type { AppConfig } from "./config"

/**
 * One JSON line per event: `{ event, request_id, metadata }`. Lines go to the
 * console (Docker and `npm run dev` collect them), and also to LOG_FILE when set.
 * Secrets in metadata are redacted; tests log warnings only.
 */

export type LogMetadata = Record<string, unknown>

const requestContext = new AsyncLocalStorage<{ request_id: string }>()

/** Run `work` with this request id on every line it logs (middleware/request-log.ts). */
export const runWithRequestId = <T>(request_id: string, work: () => T): T => requestContext.run({ request_id }, work)

export class LogService {
    constructor(private readonly logger: Logger) {}

    info(event: string, metadata?: LogMetadata): void { this.write("info", event, metadata) }
    warn(event: string, metadata?: LogMetadata): void { this.write("warn", event, metadata) }
    error(event: string, metadata?: LogMetadata): void { this.write("error", event, metadata) }
    errorWithCause(event: string, error: unknown, metadata?: LogMetadata): void { this.write("error", event, { ...metadata, error }) }

    private write(level: "info" | "warn" | "error", event: string, metadata?: LogMetadata): void {
        this.logger[level]({ event_id: randomUUID(), event, ...requestContext.getStore(), metadata })
    }
}

const REDACT = ["password", "passwordHash", "access_token", "refresh_token", "authorization", "cookie", "inviteToken", "error.stack"]

/** `destination` replaces the console (tests read the lines from it). */
export function createLogger(config: Pick<AppConfig, "logFile" | "serviceName" | "mode">, destination: pino.DestinationStream = process.stdout): LogService {
    const streams: pino.StreamEntry[] = [{ stream: destination }]
    if (config.logFile) {
        mkdirSync(dirname(config.logFile), { recursive: true })
        streams.push({ stream: pino.destination(config.logFile) })
    }
    return new LogService(pino({
        level: config.mode === "test" ? "warn" : "info",
        base: { service: config.serviceName, environment: config.mode },
        redact: { paths: REDACT.map((key) => `metadata.${key}`), censor: "[REDACTED]" },
    }, pino.multistream(streams)))
}
