import { randomUUID } from "node:crypto"
import type { RequestHandler } from "express"

import { runWithRequestId, type LogService } from "../logging"

/** Give each request an id (or keep a sane incoming X-Request-Id), and log one line when it finishes. */
export function requestLog(logger: LogService): RequestHandler {
    return (req, res, next) => {
        const incoming = req.header("x-request-id")
        const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID()
        res.setHeader("x-request-id", requestId)

        const startedAt = Date.now()
        res.on("finish", () => {
            logger.info("request.completed", { method: req.method, path: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - startedAt })
        })
        runWithRequestId(requestId, next)
    }
}
