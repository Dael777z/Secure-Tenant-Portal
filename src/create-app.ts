import express, { type Application, type Request, type Response } from "express"
import cookieParser from "cookie-parser"

import type { AppConfig } from "./config"
import type { LogService } from "./logging"
import { createAuth } from "./middleware/auth"
import { errorHandler } from "./middleware/errors"
import { verifyRequestOrigin } from "./middleware/origin"
import { createRateLimits } from "./middleware/rate-limit"
import { requestLog } from "./middleware/request-log"
import { privateApiCache, securityHeaders } from "./middleware/security"
import { createAuthRouter } from "./routes/auth"
import { createManagerRouter } from "./routes/manager"
import { createPlaidRouter } from "./routes/plaid"
import { createTenantRouter } from "./routes/tenant"
import type { AuthService } from "./services/auth"
import type { ManagerService } from "./services/manager-service"
import type { PlaidGateway } from "./services/plaid"
import type { TenantService } from "./services/tenant-service"
import type { HealthStore } from "./types/stores"

/** Everything the Express app needs, handed in (container.ts builds the real ones). */
export interface AppDependencies {
    config: AppConfig
    logger: LogService
    /** For /health/ready. */
    health: HealthStore
    auth: AuthService
    manager: ManagerService
    tenant: TenantService
    /** Null when Plaid is not configured: the bank-link routes answer 503. */
    plaid: PlaidGateway | null
    /** The built frontend (index.html and assets). Leave out when Vite serves it (development, tests). */
    distRoot?: string
}

/**
 * The Express app, not yet listening (app.ts starts it; integration tests drive it directly).
 * A request passes through, in order: request log → security headers → body and
 * cookies → origin check → the /api routes → the built frontend → error handler.
 */
export function createApp(deps: AppDependencies): Application {
    const { config, logger, health, distRoot } = deps
    const guard = createAuth(config, logger)
    const limits = createRateLimits(config)
    const app: Application = express()

    app.set("trust proxy", config.trustProxyHops)

    // Health checks come first, so Docker's probes stay out of the request log.
    // live: the process answers. ready: it can also reach Postgres.
    app.get("/health/live", (_req: Request, res: Response) => {
        res.status(200).json({ ok: true })
    })
    app.get("/health/ready", async (_req: Request, res: Response) => {
        try {
            await health.checkHealth()
            res.status(200).json({ ok: true })
        } catch {
            res.status(503).json({ ok: false })
        }
    })

    app.use(requestLog(logger))
    app.use(securityHeaders({ production: config.production, https: config.webOrigin.startsWith("https://") }))
    app.use(privateApiCache)
    // 6 MB: room for a payment receipt (at most 4 MB, sent as base64).
    app.use(express.json({ limit: "6mb" }))
    app.use(cookieParser())
    app.use(verifyRequestOrigin(config.webOrigin))

    app.use("/api", createAuthRouter({ auth: deps.auth, guard, limits, config }))
    app.use("/api", createPlaidRouter({ plaid: deps.plaid, tenant: deps.tenant, guard, limits, tokenEncryptionKey: config.tokenEncryptionKey }))
    app.use("/api", createTenantRouter({ tenant: deps.tenant, guard, limits, plaidEnabled: deps.plaid !== null, testPayments: !config.production }))
    app.use("/api", createManagerRouter({ manager: deps.manager, guard, limits, webOrigin: config.webOrigin }))

    // Unknown API paths are a JSON 404; with a built frontend, any other GET is the single-page app.
    app.use("/api", (_req, res) => {
        res.status(404).json({ error: "NOT_FOUND" })
    })
    if (distRoot) {
        app.use(express.static(distRoot))
        app.get("/{*splat}", (_req, res) => {
            res.sendFile("index.html", { root: distRoot })
        })
    }

    app.use(errorHandler(logger))

    return app
}
