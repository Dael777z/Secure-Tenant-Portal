import { silentLogger, type LogService } from "../logging"
import { runAs, SYSTEM } from "../db/identity"
import type { LedgerStore } from "../types/stores"
import { localDate } from "./ledger"

// long term persistent service that attempts to generate rent charges on the database every 6 hours
export class RentChargeService {
    private timer: NodeJS.Timeout | null = null

    constructor(
        private readonly db: Pick<LedgerStore, "generateRentCharges">,
        private readonly timeZone: string,
        private readonly logger: LogService = silentLogger,
    ) {}

    /** Add every rent charge that is due and missing. Returns how many were added. */
    // logs rent.charges.succeeded { added } or rent.charges.failed
    async run(): Promise<number> {
        const today = localDate(new Date(), this.timeZone)
        return this.logger.flow("rent.charges", { today }, () => runAs(SYSTEM, () => this.db.generateRentCharges(today)), (added) => ({ added }))
    }

    start(intervalMs = 6 * 60 * 60 * 1000): void {
        if (this.timer) return
        const tick = () => this.run().catch(() => undefined)   // already logged; the next tick tries again
        void tick()
        this.timer = setInterval(tick, intervalMs)
        this.timer.unref()   // never keeps the process alive
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }
}
