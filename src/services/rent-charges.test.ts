import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { currentIdentity, type Identity } from "../db/identity"
import { createLogger } from "../logging"
import { RentChargeService } from "./rent-charges"

function captureLog() {
    const lines: Array<{ event: string; level: number; metadata?: Record<string, unknown> }> = []
    const logger = createLogger({ logFile: "", serviceName: "test", mode: "development" }, { write: (line: string) => { lines.push(JSON.parse(line)) } })
    return { lines, logger }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("RentChargeService.run", () => {
    it("bills for today's date in the portal's time zone, not UTC", async () => {
        vi.setSystemTime(new Date("2026-11-01T05:30:00Z"))   // still the evening of Oct 31 in Denver
        const db = { generateRentCharges: vi.fn(async (_today: string) => 2) }
        expect(await new RentChargeService(db, "America/Denver").run()).toBe(2)
        expect(db.generateRentCharges).toHaveBeenLastCalledWith("2026-10-31")
        await new RentChargeService(db, "Asia/Tokyo").run()
        expect(db.generateRentCharges).toHaveBeenLastCalledWith("2026-11-01")
    })

    it("runs as the system, not as whoever happens to be signed in", async () => {
        const seen: Identity[] = []
        const db = { generateRentCharges: vi.fn(async () => { seen.push(currentIdentity()); return 0 }) }
        await new RentChargeService(db, "America/Denver").run()
        expect(seen).toEqual([{ type: "system" }])
    })

    it("logs how many charges were added", async () => {
        const { lines, logger } = captureLog()
        await new RentChargeService({ generateRentCharges: async () => 3 }, "America/Denver", logger).run()
        expect(lines.find((l) => l.event === "rent.charges.succeeded")?.metadata).toMatchObject({ added: 3 })
    })

    it("logs a failure and passes it on", async () => {
        const { lines, logger } = captureLog()
        const service = new RentChargeService({ generateRentCharges: async () => { throw new Error("db down") } }, "America/Denver", logger)
        await expect(service.run()).rejects.toThrow("db down")
        expect(lines.find((l) => l.event === "rent.charges.failed")?.level).toBe(50)   // pino "error"
    })
})

describe("RentChargeService.start / stop", () => {
    it("runs at once, then on every interval, and only one timer even if started twice", async () => {
        const db = { generateRentCharges: vi.fn(async () => 0) }
        const service = new RentChargeService(db, "America/Denver")
        service.start(1000)
        service.start(1000)
        await vi.advanceTimersByTimeAsync(0)
        expect(db.generateRentCharges).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(2500)
        expect(db.generateRentCharges).toHaveBeenCalledTimes(3)
        service.stop()
    })

    it("stop ends the schedule", async () => {
        const db = { generateRentCharges: vi.fn(async () => 0) }
        const service = new RentChargeService(db, "America/Denver")
        service.start(1000)
        await vi.advanceTimersByTimeAsync(1000)
        service.stop()
        const calls = db.generateRentCharges.mock.calls.length
        await vi.advanceTimersByTimeAsync(5000)
        expect(db.generateRentCharges).toHaveBeenCalledTimes(calls)
    })

    it("a failed run does not stop the schedule: the next tick tries again", async () => {
        const db = { generateRentCharges: vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(1) }
        const service = new RentChargeService(db, "America/Denver")
        service.start(1000)
        await vi.advanceTimersByTimeAsync(1000)
        expect(db.generateRentCharges).toHaveBeenCalledTimes(2)
        service.stop()
    })
})
