import { describe, expect, it } from "vitest"

import { createLogger, runWithRequestId } from "./logging"

/** A logger with the app's real settings whose lines land in `lines`. */
function capture() {
    const lines: Array<Record<string, unknown>> = []
    const logger = createLogger({ logFile: "", serviceName: "portal", mode: "development" }, {
        write: (chunk: string) => { lines.push(JSON.parse(chunk)) },
    })
    return { logger, lines }
}

describe("logging", () => {
    it("adds the request's id to every line written during it", () => {
        const { logger, lines } = capture()
        runWithRequestId("req-1", () => logger.info("payment.recorded"))
        logger.info("outside")
        expect(lines.map((l) => [l.event, l.request_id])).toEqual([["payment.recorded", "req-1"], ["outside", undefined]])
    })

    it("redacts secrets in metadata", () => {
        const { logger, lines } = capture()
        logger.info("auth.login", { password: "secret", refresh_token: "token", inviteToken: "abc", safe: "visible" })
        expect(lines[0]!.metadata).toEqual({ password: "[REDACTED]", refresh_token: "[REDACTED]", inviteToken: "[REDACTED]", safe: "visible" })
    })
})
