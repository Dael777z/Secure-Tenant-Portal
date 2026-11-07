import express, { type Application, type Request, type Response } from "express"
import cookieParser from "cookie-parser"

import type { AppConfig } from "./config"
import type { LogService } from "./logging"
import { createAuth } from "./middleware/auth"
import { errorHandler } from "./middleware/errors"
import { jsonBody } from "./middleware/body"
import { verifyRequestOrigin } from "./middleware/origin"
import { createRateLimits } from "./middleware/rate-limit"
import { requestLog } from "./middleware/request-log"
import { privateApiCache, securityHeaders } from "./middleware/security"
import { createAuthRouter } from "./routes/auth"
import { createFinanceRouter } from "./routes/finance"
import { createManagerRouter } from "./routes/manager"
import { createOperationsRouter } from "./routes/operations"
import { createMessageRouter } from "./routes/messages"
import { createPlaidRouter } from "./routes/plaid"
import { createStripePaymentRouter, createStripeWebhookRouter } from "./routes/stripe"
import { createTenantRouter } from "./routes/tenant"
import { createLeasingRouter } from "./routes/leasing"
import { createMaintenanceDetailRouter } from "./routes/maintenance-detail"
import { createNoticesRouter } from "./routes/notices"
import { createOfficeRouter } from "./routes/office"
import type { AuthService } from "./services/auth"
import type { ManagerService } from "./services/manager-service"
import type { MessageService } from "./services/message-service"
import type { FinanceService } from "./services/finance-service"
import type { OperationsService } from "./services/operations-service"
import type { PlaidGateway } from "./services/plaid"
import type { StripePaymentService } from "./services/stripe-payments"
import type { TenantService } from "./services/tenant-service"
import type { LeasingService } from "./services/leasing-service"
import type { MaintenanceDetailService } from "./services/maintenance-detail-service"
import type { NoticesService } from "./services/notices-service"
import type { OfficeService } from "./services/office-service"
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
    /** Tenant ↔ office messages (004). */
    messages: MessageService
    /** Collections, P&L, performance, expenses, leases ending soon (005). */
    finance: FinanceService
    /** RentRedi-style management (008). */
    operations: OperationsService
    /** 009: team, activity, portfolios, details, compliance, reports, search. */
    office: OfficeService
    /** 009: one maintenance request in detail, its photos and cost. */
    maintenanceDetail: MaintenanceDetailService
    /** 009: notices to residents, and documents. */
    notices: NoticesService
    /** 009: listings, leads and the public listings page. */
    leasing: LeasingService
    /** Null when Plaid is not configured: the bank-link routes answer 503. */
    plaid: PlaidGateway | null
    /** Cards, Apple Pay and Google Pay through Stripe (010); answers 503 when Stripe is not configured. */
    stripePayments: StripePaymentService
    /** The built frontend (index.html and assets). Leave out when Vite serves it (development, tests). */
    distRoot?: string
}

/**
 * The Express app, not yet listening (app.ts starts it; integration tests drive it directly).
 * A request passes through, in order: request log → security headers → origin check → Stripe's
 * webhook (raw body) → body and cookies → the /api routes → the built frontend → error handler.
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
    // Headers only, so it can come first: every write refuses another site's page, the webhook too
    // (Stripe's servers send no Origin or Sec-Fetch-Site, so they pass).
    app.use(verifyRequestOrigin(config.webOrigin))
    // Stripe signs the exact bytes it sends, so its webhook reads the raw body: before the JSON parser.
    app.use("/api", createStripeWebhookRouter({ payments: deps.stripePayments }))
    // 100 KB, except the receipt routes (middleware/body.ts).
    app.use(jsonBody)
    app.use(cookieParser())

    app.use("/api", createAuthRouter({ auth: deps.auth, guard, limits, config }))
    app.use("/api", createPlaidRouter({ plaid: deps.plaid, tenant: deps.tenant, guard, limits, tokenEncryptionKey: config.tokenEncryptionKey }))
    app.use("/api", createTenantRouter({
        tenant: deps.tenant, guard, limits, plaidEnabled: deps.plaid !== null, testPayments: !config.production,
        stripePublishableKey: deps.stripePayments.publishableKey, cardFee: deps.stripePayments.cardFee,
    }))
    app.use("/api", createStripePaymentRouter({ payments: deps.stripePayments, guard, limits }))
    // Before the manager router, so /manager/leases/expiring is not read as a lease id.
    app.use("/api", createFinanceRouter({ finance: deps.finance, guard, limits }))
    // 009, before the manager router: /manager/maintenance/summary and /manager/documents/all are not ids.
    app.use("/api", createOfficeRouter({ office: deps.office, guard, limits, webOrigin: config.webOrigin }))
    app.use("/api", createMaintenanceDetailRouter({ maintenance: deps.maintenanceDetail, guard, limits }))
    app.use("/api", createNoticesRouter({ notices: deps.notices, guard, limits }))
    app.use("/api", createLeasingRouter({ leasing: deps.leasing, guard, limits }))
    // Before the manager router too: /manager/leases/:id/charges (repeating charges) and the 008 screens.
    app.use("/api", createOperationsRouter({ operations: deps.operations, guard, limits }))
    app.use("/api", createManagerRouter({ manager: deps.manager, guard, limits, webOrigin: config.webOrigin }))
    app.use("/api", createMessageRouter({ messages: deps.messages, guard, limits }))

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
