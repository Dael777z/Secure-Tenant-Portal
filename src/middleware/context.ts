import crypto from "crypto"
import type { RequestHandler } from "express"
import { runWithLogContext } from "../logging/context"

export const context: RequestHandler = (req, res, next): void => {
    const incoming_id = req.header("x-request-id")
    
    const request_id = incoming_id && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming_id)
        ? incoming_id 
        : crypto.randomUUID()

    res.setHeader("x-request-id", request_id)
    runWithLogContext({ request_id }, next)
}
