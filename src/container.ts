import type { Pool } from "pg"

import { configFromEnvironment, type AppConfig } from "./config"
import type { AppDependencies } from "./create-app"
import { checkDatabase } from "./db/migrate"
import { createPool } from "./db/pool"
import { PostgresDatabase } from "./db/postgres-db"
import { createLogger, type LogService } from "./logging"
import { AuthService } from "./services/auth"
import { createResendSender, type EmailSender } from "./services/email"
import { ManagerService } from "./services/manager-service"
import { MessageService } from "./services/message-service"
import { NotificationService } from "./services/notifications"
import { createPlaidGateway, type PlaidGateway } from "./services/plaid"
import { RentChargeService } from "./services/rent-charges"
import { createStripeGateway, type StripeGateway } from "./services/stripe"
import { StripePaymentService } from "./services/stripe-payments"
import { TenantService } from "./services/tenant-service"
import type { DatabaseInterface } from "./types/stores"

/**
 * Builds the real dependencies; the one place that decides how the backend is wired:
 *
 *   config → pool → PostgresDatabase → AuthService, ManagerService, TenantService, MessageService, RentChargeService
 *                                    → NotificationService (Resend) → TenantService, MessageService
 *
 *                                    → StripePaymentService (Cash App Pay)
 *
 * Tests pass their own `config`, a `db` on a test database, `plaid: null`, `stripe` (a fake gateway), `email` (a fake sender),
 * or a `logger` they read.
 */
export interface Container extends AppDependencies {
    rentCharges: RentChargeService
    /** Email notifications (005); sends nothing unless RESEND_API_KEY and EMAIL_FROM are set. */
    notifications: NotificationService
    /** Throws a message saying what to run if the app cannot use the database. */
    checkDatabase(): Promise<void>
    close(): Promise<void>
}

export function createContainer(overrides: { config?: AppConfig; db?: DatabaseInterface; plaid?: PlaidGateway | null; stripe?: StripeGateway | null; email?: EmailSender | null; distRoot?: string; logger?: LogService } = {}): Container {
    const config = overrides.config ?? configFromEnvironment()
    const logger = overrides.logger ?? createLogger(config)

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
    const stripe = overrides.stripe !== undefined ? overrides.stripe
        : config.stripeSecretKey && config.stripePublishableKey ? createStripeGateway({
            secretKey: config.stripeSecretKey,
            publishableKey: config.stripePublishableKey,
            webhookSecret: config.stripeWebhookSecret,
            logger,
            verboseErrors: !config.production,
        })
        : null
    const rentCharges = new RentChargeService(db, config.timeZone, logger)
    const email = overrides.email !== undefined ? overrides.email
        : config.resendApiKey && config.emailFrom ? createResendSender({ apiKey: config.resendApiKey, from: config.emailFrom, logger })
        : null
    const notifications = new NotificationService(db, email, {
        timeZone: config.timeZone,
        webOrigin: config.webOrigin,
        sendFromHour: config.emailSendFromHour,
        leaseEndingNoticeDays: config.leaseEndingNoticeDays,
    }, rentCharges, logger)

    return {
        config,
        logger,
        health: db,
        auth: new AuthService(db, config, logger),
        manager: new ManagerService(db, config.timeZone, logger),
        tenant: new TenantService(db, config.timeZone, logger, notifications),
        messages: new MessageService(db, config.timeZone, notifications),
        plaid,
        stripePayments: new StripePaymentService(db, stripe, config.timeZone, logger),
        distRoot: overrides.distRoot,
        rentCharges,
        notifications,
        async checkDatabase() {
            if (pool) await checkDatabase(pool)
        },
        async close() {
            rentCharges.stop()
            notifications.stop()
            await pool?.end()
        },
    }
}
