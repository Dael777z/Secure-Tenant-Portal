import pino, { type DestinationStream } from "pino"
import { describe, expect, it } from "vitest"
import { LogService } from "./log-service"

function createTestLogger(events: Record<string, unknown>[]): LogService {
    const stream: DestinationStream = {
        write(chunk: string): boolean {
            events.push(JSON.parse(chunk))
            return true
        },
    }

    return new LogService(pino({
        base: { service: "test", environment: "test" },
        redact: {
            paths: ["metadata.password", "metadata.refresh_token"],
            censor: "[REDACTED]",
        },
    }, stream))
}

describe("LogService", () => {
    it("keeps flow_id on every flow event outside request context", () => {
        const events: Record<string, unknown>[] = []
        const logger = createTestLogger(events)

        const flow = logger.startFlow("payment.process")
        flow.event("payment.authorized")
        flow.success()

        expect(events).toHaveLength(3)
        expect(new Set(events.map((event) => event.flow_id))).toEqual(new Set([flow.flow_id]))
    })

    it("redacts sensitive metadata through the logger configuration", () => {
        const events: Record<string, unknown>[] = []
        const logger = createTestLogger(events)

        logger.info("auth.login", {
            password: "secret",
            refresh_token: "token",
            safe_value: "visible",
        })

        expect(events[0].metadata).toEqual({
            password: "[REDACTED]",
            refresh_token: "[REDACTED]",
            safe_value: "visible",
        })
    })
})
