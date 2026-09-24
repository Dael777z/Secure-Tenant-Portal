import type { RequestHandler } from "express"
import { LogService } from "../logging/log-service"

export function logging(logger: LogService): RequestHandler {
    return (req, res, next): void => {
        const startedAt = Date.now()

        res.on("finish", () => {
            const durationMs = Date.now() - startedAt
            logger.info("request.completed", {
                method: req.method,
                path: req.originalUrl,
                statusCode: res.statusCode,
                durationMs,
            })
        })

        next()
    }
}