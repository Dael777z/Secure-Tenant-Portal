import { rateLimit } from "express-rate-limit"
import type { RequestHandler } from "express"

import type { AppConfig } from "../config"

// outlines the different rate limitters
export interface RateLimits {
    login: RequestHandler
    signup: RequestHandler
    refresh: RequestHandler
    /** Payments, receipts, invites, bank links. */
    sensitive: RequestHandler
    /** Sending a message: a conversation needs more room than `sensitive`. */
    messages: RequestHandler
}

// translates the rateLimits of AppConfig into a RateLimits tuple
export function createRateLimits(config: Pick<AppConfig, "rateLimits">): RateLimits {

    // lambda to create a rateLimit handler from a request number limit
    const limiter = (limit: number) => rateLimit({
        windowMs: 15 * 60 * 1000,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "RATE_LIMITED" },
    })

    // unpacks the configs rate limits
    const { login, signup, refresh, sensitive, messages } = config.rateLimits

    // invokes the lambda for every type specified for the rate limiter object
    return { login: limiter(login), signup: limiter(signup), refresh: limiter(refresh), sensitive: limiter(sensitive), messages: limiter(messages) }
}
