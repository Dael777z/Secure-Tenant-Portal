import { randomUUID } from "node:crypto"
import type { RequestHandler } from "express"

import { runWithRequestId, type LogService } from "../logging"

/* attach a request id in the headers of incoming requests, if the request is already associated with an existing request, carry the requests existing id

enables the remaining execution to be aware of the request it is attached to, this is important for observability and tracking how requests flow through services.

*/
export function requestLog(logger: LogService): RequestHandler {
    return (req, res, next) => {
        const incoming = req.header("x-request-id") // check request existing header
        const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID() // resolve requestid to the incoming id if it is not null and is not noise otherwise generate a new request id
        res.setHeader("x-request-id", requestId) // attach the qualified request id to the id header

        const startedAt = Date.now()

        // log when this request completed and how long it took
        res.on("finish", () => runWithRequestId(requestId, () => {   // "finish" fires outside the request's context
            logger.info("request.completed", {
                method: req.method,
                path: req.originalUrl.split("?")[0],   // no query string: sign-up and oauth links carry tokens
                statusCode: res.statusCode,
                ...(res.locals.errorCode ? { error: res.locals.errorCode } : {}),   // set by middleware/errors.ts
                durationMs: Date.now() - startedAt,
            })
        }))

        runWithRequestId(requestId, next) // run the remaining middleware with the async local storage context associated with this request id
    }
}
