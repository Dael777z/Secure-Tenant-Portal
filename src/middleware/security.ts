import helmet from "helmet"
import type { RequestHandler } from "express"

/**
 * Helmet. CSP only in production (Vite's dev server needs inline scripts). HSTS
 * and "upgrade to https" only when the site is served over https: a production
 * build on http://localhost (npm run prod, docker:prod) must keep loading over http.
 */
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

export const privateApiCache: RequestHandler = (req, res, next): void => {
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store")
    next()
}
