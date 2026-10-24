import type { ErrorRequestHandler } from "express"

import type { LogService } from "../logging"
import { AppError, ERROR_STATUS } from "../types/errors"

// translate app errors for http request errors
export function errorHandler(logger: LogService): ErrorRequestHandler {
    return (error, _req, res, _next) => {
        res.locals.errorCode = error instanceof AppError ? error.code : "INTERNAL_SERVER_ERROR"   // for request.completed
        if (error instanceof AppError) {
            res.status(ERROR_STATUS[error.code]).json(error.details ? { error: error.code, details: error.details } : { error: error.code })
            return
        }

        logger.errorWithCause("request.failed", error)
        res.status(500).json({ error: "INTERNAL_SERVER_ERROR" })
    }
}
