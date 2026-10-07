import type { ErrorRequestHandler } from "express"
import { AppError } from "../types/errors"
import { LogService } from "../logging/log-service"

const statusByCode = {
    EMAIL_IN_USE: 409,
    INVALID_CREDENTIALS: 401,
    INVALID_TOKEN: 401,
    USER_NOT_FOUND: 404,
    VALIDATION_ERROR: 400,
    SIGNUP_NOT_ALLOWED: 403,
    NO_ACTIVE_LEASE: 404,
    NOT_FOUND: 404,
    DATABASE_REQUIRED: 503,
    PLAID_NOT_CONFIGURED: 503,
    PLAID_ERROR: 502,
} as const

export function errorHandler(logger: LogService): ErrorRequestHandler {
    return (error, _req, res, _next) => {
        if (error instanceof AppError) {
            res.status(statusByCode[error.code]).json({ error: error.code })
            return
        }

        logger.errorWithCause("request.failed", error)
        res.status(500).json({ error: "INTERNAL_SERVER_ERROR" })
    }
}