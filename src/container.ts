import type { Pool } from "pg"

import { configFromEnvironment, type AppConfig } from "./config"
import type { AppDependencies } from "./create-app"
import { checkDatabase } from "./db/migrate"
import { createPool } from "./db/pool"
import { PostgresDatabase } from "./db/postgres-db"
import { createLogger } from "./logging"
import { AuthService } from "./services/auth"
import { ManagerService } from "./services/manager-service"
import { createPlaidGateway, type PlaidGateway } from "./services/plaid"
import { RentChargeService } from "./services/rent-charges"
import { TenantService } from "./services/tenant-service"
import type { DatabaseInterface } from "./types/stores"

/**
 * Builds the real dependencies; the one place that decides how the backend is wired:
 *
 *   config → pool → PostgresDatabase → AuthService, ManagerService, TenantService, RentChargeService
 *
 * Tests pass their own `config`, a `db` on a test database, or `plaid: null`.
 */
export interface Container extends AppDependencies {
    rentCharges: RentChargeService
    /** Throws a message saying what to run if the app cannot use the database. */
    checkDatabase(): Promise<void>
    close(): Promise<void>
}

export function createContainer(overrides: { config?: AppConfig; db?: DatabaseInterface; plaid?: PlaidGateway | null; distRoot?: string } = {}): Container {
    const config = overrides.config ?? configFromEnvironment()
    const logger = createLogger(config)

    let pool: Pool | undefined
    let db = overrides.db
    if (!db) {
        if (!config.databaseUrl) throw new Error("No database login for the app: set APP_DB_PASSWORD (or DATABASE_URL).")
        pool = createPool(config.databaseUrl)
        db = new PostgresDatabase(pool)
    }

    const plaid = overrides.plaid !== undefined ? overrides.plaid
        : config.plaidClientId && config.plaidSecret ? createPlaidGateway({
            clientId: config.plaidClientId,
            secret: config.plaidSecret,
            env: config.plaidEnv,
            redirectUri: config.plaidRedirectUri,
            logger,
            verboseErrors: !config.production,
        })
        : null
    const rentCharges = new RentChargeService(db, config.timeZone, logger)

    return {
        config,
        logger,
        health: db,
        auth: new AuthService(db, config),
        manager: new ManagerService(db, config.timeZone),
        tenant: new TenantService(db, config.timeZone),
        plaid,
        distRoot: overrides.distRoot,
        rentCharges,
        async checkDatabase() {
            if (pool) await checkDatabase(pool)
        },
        async close() {
            rentCharges.stop()
            await pool?.end()
        },
    }
}
