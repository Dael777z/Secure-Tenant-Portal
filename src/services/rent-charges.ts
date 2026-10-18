import type { LogService } from "../logging"
import { runAs, SYSTEM } from "../db/identity"
import type { LedgerStore } from "../types/stores"
import { localDate } from "./ledger"

// long term persistent service that attempts to generate rent charges on the database every 6 hours
export class RentChargeService {
    private timer: NodeJS.Timeout | null = null

    constructor(
        private readonly db: Pick<LedgerStore, "generateRentCharges">,
        private readonly timeZone: string,
        private readonly logger?: LogService,
    ) {}

    /** Add every rent charge that is due and missing. Returns how many were added. */
    async run(): Promise<number> {
        return runAs(SYSTEM, () => this.db.generateRentCharges(localDate(new Date(), this.timeZone)))
    }

    start(intervalMs = 6 * 60 * 60 * 1000): void {
        if (this.timer) return
        const tick = () => this.run().then(
            (added) => this.logger?.info("rent_charges.run", { added }),
            (error) => this.logger?.errorWithCause("rent_charges.failed", error),
        )
        void tick()
        this.timer = setInterval(tick, intervalMs)
        this.timer.unref()   // never keeps the process alive
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }
}
