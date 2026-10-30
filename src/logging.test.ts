import { describe, expect, it } from "vitest"

import { createLogger, runWithRequestId } from "./logging"
import { AppError } from "./types/errors"

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

    it("logs how a flow ended: what it produced, the app's refusal, or what broke", async () => {
        const { logger, lines } = capture()
        await expect(logger.flow("payment.tenant", { amount: 5 }, async () => "TEN-1", (confirmation) => ({ confirmation }))).resolves.toBe("TEN-1")
        await expect(logger.flow("payment.tenant", { amount: 5 }, async () => { throw new AppError("NO_ACTIVE_LEASE", { leaseId: null }) })).rejects.toThrow(AppError)
        await expect(logger.flow("rent.charges", {}, async () => { throw new Error("db down") })).rejects.toThrow("db down")

        expect(lines.map((l) => [l.event, l.level])).toEqual([["payment.tenant.succeeded", 30], ["payment.tenant.failed", 40], ["rent.charges.failed", 50]])
        expect(lines[0]!.metadata).toMatchObject({ amount: 5, confirmation: "TEN-1", durationMs: expect.any(Number) })
        expect(lines[1]!.metadata).toMatchObject({ amount: 5, code: "NO_ACTIVE_LEASE", leaseId: null })
        expect((lines[2]!.metadata as { error: { message: string } }).error.message).toBe("db down")
    })
})
