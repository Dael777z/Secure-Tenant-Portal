import crypto from "crypto"
import type { Logger } from "pino"

import { getLogContext, runWithAdditionalLogContext, updateLogContext } from "./context"

export type LogMetadata = Record<string, unknown>

export class LogService {
    constructor(private readonly logger: Logger) {}

    debug(event: string, metadata?: LogMetadata): void { this.write("debug", event, metadata) }
    info(event: string, metadata?: LogMetadata): void { this.write("info", event, metadata) }
    warn(event: string, metadata?: LogMetadata): void { this.write("warn", event, metadata) }
    error(event: string, metadata?: LogMetadata): void { this.write("error", event, metadata) }
    fatal(event: string, metadata?: LogMetadata): void { this.write("fatal", event, metadata) }

    errorWithCause(event: string, error: unknown, metadata?: LogMetadata): void {
        this.write("error", event, { ...metadata, error })
    }

    startFlow(name: string, metadata?: LogMetadata): FlowLog {
        const flow_id = crypto.randomUUID()
        updateLogContext({ flow_id })
        this.withFlow(flow_id, () => this.info(`${name}.started`, metadata))
        return new FlowLog(this, flow_id, name)
    }

    withFlow<T>(flow_id: string, callback: () => T): T {
        return runWithAdditionalLogContext({ flow_id }, callback)
    }

    private write(level: string, event: string, metadata?: LogMetadata): void {
        const context = getLogContext()
        this.logger[level as "debug" | "info" | "warn" | "error" | "fatal"]({
            event_id: crypto.randomUUID(),
            event,
            ...context,
            metadata,
        })
    }
}

export class FlowLog {
    constructor(
        private readonly logger: LogService,
        readonly flow_id: string,
        private readonly name: string,
    ) {}

    event(name: string, metadata?: LogMetadata): void {
        this.logger.withFlow(this.flow_id, () => this.logger.info(name, metadata))
    }

    child(name: string, metadata?: LogMetadata): FlowLog {
        this.logger.withFlow(this.flow_id, () => this.logger.info(`${this.name}.${name}.started`, metadata))
        return new FlowLog(this.logger, this.flow_id, `${this.name}.${name}`)
    }

    success(metadata?: LogMetadata): void {
        this.logger.withFlow(this.flow_id, () => this.logger.info(`${this.name}.succeeded`, metadata))
    }

    failure(error: unknown, metadata?: LogMetadata): void {
        this.logger.withFlow(this.flow_id, () => this.logger.errorWithCause(`${this.name}.failed`, error, metadata))
    }
}
