import express from "express"
import type { RequestHandler } from "express"

/**
 * Request bodies. Most routes take a few hundred bytes of JSON, so the default
 * limit is small: a large body is read into memory before anything else runs, and
 * with a big limit anyone, signed in or not, could use that to exhaust the server.
 * Only the two routes that take a receipt (a base64 file of up to 4 MB) get the
 * large limit, and they get it after the caller has signed in and passed the rate limit.
 */
export const DEFAULT_BODY_LIMIT = "100kb"
export const RECEIPT_BODY_LIMIT = "6mb"

/** POST /manager/leases/:id/payments (a payment may carry a receipt), PUT .../payments/:id/receipt and PUT .../document (the signed lease PDF). */
const RECEIPT_ROUTES: Array<{ method: string; path: RegExp }> = [
    { method: "PUT", path: /^\/api\/manager\/leases\/[^/]+\/document\/?$/ },
    { method: "POST", path: /^\/api\/manager\/leases\/[^/]+\/payments\/?$/ },
    { method: "PUT", path: /^\/api\/manager\/leases\/[^/]+\/payments\/[^/]+\/receipt\/?$/ },
]
/** 009: a document (10 MB) or a maintenance photo (5 MB), as base64 JSON. Signed-in routes only, after their checks. */
export const UPLOAD_BODY_LIMIT = "15mb"
const UPLOAD_ROUTES: Array<{ method: string; path: RegExp }> = [
    { method: "POST", path: /^\/api\/manager\/documents\/?$/ },
    { method: "POST", path: /^\/api\/manager\/maintenance\/[^/]+\/attachments\/?$/ },
    { method: "POST", path: /^\/api\/tenant\/maintenance\/[^/]+\/attachments\/?$/ },
    // 012, 013: a reported Cash App / Zelle payment carries a screenshot; the office uploads its QR codes.
    { method: "POST", path: /^\/api\/tenant\/payments\/report\/?$/ },
    { method: "PUT", path: /^\/api\/manager\/settings\/(cashapp|zelle)-qr\/?$/ },
]
const takesReceipt = (method: string, path: string) => [...RECEIPT_ROUTES, ...UPLOAD_ROUTES].some((r) => r.method === method && r.path.test(path))

const small = express.json({ limit: DEFAULT_BODY_LIMIT })

/** Reads JSON bodies up to the small limit, and leaves the receipt routes for `receiptBody`. */
export const jsonBody: RequestHandler = (req, res, next) => (takesReceipt(req.method, req.path) ? next() : small(req, res, next))

/** Put this on a receipt route after its sign-in and permission checks. */
export const receiptBody: RequestHandler = express.json({ limit: RECEIPT_BODY_LIMIT })

/** Put this on an upload route (UPLOAD_ROUTES) after its sign-in and permission checks. */
export const uploadBody: RequestHandler = express.json({ limit: UPLOAD_BODY_LIMIT })
