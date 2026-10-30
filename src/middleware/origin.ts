import type { RequestHandler } from "express"

import { AppError } from "../types/errors"

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"])

// validates our cross origin policy, requests must come from our site/web origin. Applied to all write http methods.
export function verifyRequestOrigin(webOrigin: string): RequestHandler {
    return (req, _res, next) => {
        const origin = req.get("origin")
        if (WRITES.has(req.method) && origin && origin !== webOrigin) throw new AppError("FORBIDDEN")
        // Browsers also say where a request came from. A write that is not from our own page
        // (another site, or another subdomain) is refused even when it carries no Origin header.
        const site = req.get("sec-fetch-site")
        if (WRITES.has(req.method) && site && site !== "same-origin" && site !== "none") throw new AppError("FORBIDDEN")
        next()
    }
}
