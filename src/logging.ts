import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import pino, { type Logger } from "pino"

import type { AppConfig } from "./config"
import { AppError } from "./types/errors"

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
    errorWithCause(event: string, error: unknown, metadata?: LogMetadata): void {
        // an Error's fields are not enumerable, so pino would write {}: spell out type, message and stack
        this.write("error", event, { ...metadata, error: error instanceof Error ? pino.stdSerializers.err(error) : error })
    }

    /**
     * Run one step of a flow and log how it ended: `<event>.succeeded` with `outcome(result)`,
     * or `<event>.failed` with the AppError code (a warning: the app refused, as designed) or
     * the error itself (an error: something broke). Both carry `metadata` and `durationMs`.
     */
    async flow<T>(event: string, metadata: LogMetadata, work: () => Promise<T>, outcome?: (result: T) => LogMetadata): Promise<T> {
        const startedAt = Date.now()
        try {
            const result = await work()
            this.info(`${event}.succeeded`, { ...metadata, ...outcome?.(result), durationMs: Date.now() - startedAt })
            return result
        } catch (error) {
            const durationMs = Date.now() - startedAt
            if (error instanceof AppError) this.warn(`${event}.failed`, { ...metadata, code: error.code, ...error.details, durationMs })
            else this.errorWithCause(`${event}.failed`, error, { ...metadata, durationMs })
            throw error
        }
    }

    private write(level: "info" | "warn" | "error", event: string, metadata?: LogMetadata): void {
        this.logger[level]({ event_id: randomUUID(), event, ...requestContext.getStore(), metadata })
    }
}

/** Writes nothing: the default for services built without a logger (unit tests). */
export const silentLogger = new LogService(pino({ level: "silent" }))

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
