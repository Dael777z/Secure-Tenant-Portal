import express, { type Application, type Request, type Response } from "express"
import cookieParser from "cookie-parser"

import type { DatabaseInterface } from "./types/interfaces"
import type { LogService } from "./logging/log-service"

import { errorHandler } from "./middleware/errors"
import { createAuthRouter } from "./routes/auth"
import { createTenantRouter } from "./routes/tenant"
import { createPlaidRouter } from "./routes/plaid"
import { createManagerRouter } from "./routes/manager"
import type { ManagerStore } from "./services/manager-store"
import type { TenantStore } from "./services/tenant-store"
import type { PlaidGateway } from "./services/plaid"
import { context } from "./middleware/context"
import { logging } from "./middleware/logging"
import { verifyRequestOrigin } from "./middleware/origin"

/**
 * The Express app, without listening. src/app.ts starts it; the integration
 * tests build one against a test database and drive it over HTTP.
 */
export function createApp(options: {
  database: DatabaseInterface
  logger: LogService
  distRoot: string
  /** Tenant pages' data (needs Postgres). Null: those routes answer 503. */
  tenantStore?: TenantStore | null
  /** Dael's Plaid link. Null: the bank-link routes answer 503. */
  plaid?: PlaidGateway | null
  /** The manager side's data (needs Postgres). Null: those routes answer 503. */
  managerStore?: ManagerStore | null
}): Application {
  const { database, logger, distRoot } = options
  const tenantStore = options.tenantStore ?? null
  const plaid = options.plaid ?? null
  const app: Application = express()

  app.set("trust proxy", 1)

  app.get("/favicon.ico", (_req: Request, res: Response) => {
    res.status(204).end()
  })

  // middleware
  app.use(context)
  app.use(express.json())
  app.use(cookieParser())
  app.use(verifyRequestOrigin)
  app.use(logging(logger))

  app.use("/api", createAuthRouter(database))
  app.use("/api", createPlaidRouter(plaid, tenantStore))
  app.use("/api", createTenantRouter(tenantStore, { plaidEnabled: plaid !== null }))
  app.use("/api", createManagerRouter(options.managerStore ?? null))

  app.use(express.static(distRoot))

  // wildcard get route for SPA
  app.get("/{*splat}", (req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "NOT_FOUND"})
      return
    }

    res.sendFile("index.html", {root: distRoot})
  })

  app.use(errorHandler(logger))

  return app
}
