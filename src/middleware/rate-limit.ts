import { rateLimit } from "express-rate-limit"
import type { RequestHandler } from "express"

import type { AppConfig } from "../config"

export interface RateLimits {
    login: RequestHandler
    signup: RequestHandler
    refresh: RequestHandler
    /** Payments, receipts, invites, bank links. */
    sensitive: RequestHandler
}

/** One limiter per kind of request, per app (so tests never share counters). Limits are in config.ts. */
export function createRateLimits(config: Pick<AppConfig, "rateLimits">): RateLimits {
    const limiter = (limit: number) => rateLimit({
        windowMs: 15 * 60 * 1000,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "RATE_LIMITED" },
    })
    const { login, signup, refresh, sensitive } = config.rateLimits
    return { login: limiter(login), signup: limiter(signup), refresh: limiter(refresh), sensitive: limiter(sensitive) }
}
