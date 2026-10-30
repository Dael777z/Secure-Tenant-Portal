import type { RequestHandler } from "express"

import { AppError } from "../types/errors"

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"])

// validates our cross origin policy, requests must come from our site/web origin. Applied to all write http methods.
export function verifyRequestOrigin(webOrigin: string): RequestHandler {
    return (req, _res, next) => {
        const origin = req.get("origin")
        if (WRITES.has(req.method) && origin && origin !== webOrigin) throw new AppError("FORBIDDEN")
        next()
    }
}
