import type { ErrorRequestHandler } from "express"

import type { LogService } from "../logging"
import { AppError, ERROR_STATUS } from "../types/errors"

/** AppErrors become `{ error: CODE }` with their status; anything else is logged and answered with a 500. */
export function errorHandler(logger: LogService): ErrorRequestHandler {
    return (error, _req, res, _next) => {
        if (error instanceof AppError) {
            res.status(ERROR_STATUS[error.code]).json({ error: error.code })
            return
        }

        logger.errorWithCause("request.failed", error)
        res.status(500).json({ error: "INTERNAL_SERVER_ERROR" })
    }
}
