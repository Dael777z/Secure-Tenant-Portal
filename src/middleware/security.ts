import helmet from "helmet"
import type { RequestHandler } from "express"

// attaches standard cross origin policy headers, checks if production and https is enabled and configures accordingly
export const securityHeaders = ({ production, https }: { production: boolean; https: boolean }): RequestHandler => helmet({
    contentSecurityPolicy: !production ? false : {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https:"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            upgradeInsecureRequests: https ? [] : null,
        },
    },
    hsts: !(production && https) ? false : { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
})

// tell the client not to cache requests to the api
export const privateApiCache: RequestHandler = (req, res, next): void => {
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store")
    next()
}
