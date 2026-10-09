import type { RequestHandler } from "express"
import { env } from "../config/env"

const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])

export const verifyRequestOrigin: RequestHandler = (req, res, next): void => {
    if (!stateChangingMethods.has(req.method)) {
        next()
        return
    }

    const origin = req.get("origin")
    if (origin && origin !== env.webOrigin) {
        res.status(403).json({ error: "Invalid request origin" })
        return
    }

    next()
}