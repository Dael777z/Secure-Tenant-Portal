import type { RequestHandler } from "express"

import { AppError } from "../types/errors"

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** A write sent by a browser must come from our own site (on top of SameSite cookies). */
export function verifyRequestOrigin(webOrigin: string): RequestHandler {
    return (req, _res, next) => {
        const origin = req.get("origin")
        if (WRITES.has(req.method) && origin && origin !== webOrigin) throw new AppError("FORBIDDEN")
        next()
    }
}
