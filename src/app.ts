import { env } from "./config/env"
import { createApp } from "./create-app"
import { createDatabase, createLogger, createPlaid, createTenantStore } from "./utils/init"
import type { DatabaseInterface } from "./types/interfaces"
import { resolve } from "node:path"

const distRoot = resolve(__dirname, "..")

const database: DatabaseInterface = createDatabase()
const logger = createLogger()
const tenantStore = createTenantStore()
const plaid = createPlaid()
const app = createApp({ database, logger, distRoot, tenantStore, plaid })

const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info("server.started", {
    address: `0.0.0.0:${env.port}`,
    database: env.databaseUrl ? "postgres" : "memory",
    plaid: plaid ? env.plaidEnv : "off",
  })
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
        logger.info("server.stopped")
    })
})
}
