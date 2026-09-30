/**
 * Composition root.
 *
 * Everything is constructed here and injected downward. Nothing below this file
 * reads process.env or reaches for a global, which is what makes the whole
 * system constructible in a test with a mock provider and a scratch database.
 */

import { setPortalTimeZone } from "../../../packages/shared/src/ids.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { Pool } from "./db/pool.ts";
import { pendingMigrations, verifySecurityPosture } from "./db/migrate.ts";
import { SessionStore } from "./auth/session.ts";
import { Router } from "./http/router.ts";
import { createServer } from "./http/server.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerTenantRoutes } from "./routes/tenant.ts";
import { registerManagerRoutes } from "./routes/manager.ts";
import { registerMessageRoutes } from "./routes/messages.ts";
import { registerPortfolioRoutes } from "./routes/portfolio.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { registerStaticRoutes } from "./routes/static.ts";
import type { PaymentProvider, ProviderEvent } from "./providers/payments/index.ts";
import { MockPaymentProvider } from "./providers/payments/mock.ts";
import { StripePaymentProvider } from "./providers/payments/stripe.ts";
import type { Transport } from "./providers/notify/index.ts";
import { ConsoleTransport } from "./providers/notify/console.ts";
import { ChannelRouter, HttpSmsTransport, SmtpTransport } from "./providers/notify/smtp.ts";
import type { Storage } from "./providers/storage/index.ts";
import { FilesystemStorage } from "./providers/storage/filesystem.ts";
import { S3Storage } from "./providers/storage/s3.ts";
import { JobRunner } from "./jobs/runner.ts";
import { SYSTEM_CONTEXT, withContext } from "./db/context.ts";
import { reconcile } from "./domain/payments.ts";
import { emit } from "./domain/notifications.ts";
import type { EventType } from "../../../packages/shared/src/notifications.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, detail?: Record<string, unknown>) => void;

export interface Application {
  config: Config;
  pool: Pool;
  router: Router;
  sessions: SessionStore;
  payments: PaymentProvider;
  transport: Transport;
  storage: Storage;
  jobs: JobRunner;
  server: Server;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createLogger(config: Config): Logger {
  return (level, message, detail) => {
    if (config.env === "test" && level === "info") return;
    // Structured, one line per event: a self-hosted operator's log pipeline is
    // usually `journalctl | grep`, and multi-line output ruins that.
    const line = {
      t: new Date().toISOString(),
      level,
      msg: message,
      ...(detail ?? {}),
    };
    const text = JSON.stringify(line);
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  };
}

export async function createApplication(overrides: Partial<Config> = {}): Promise<Application> {
  const config = { ...loadConfig(), ...overrides } as Config;
  const log = createLogger(config);
  setPortalTimeZone(config.timeZone);

  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    ssl: config.database.ssl,
    connectTimeoutMs: 10_000,
    statementTimeoutMs: config.database.statementTimeoutMs,
    applicationName: "resident-portal",
    max: config.database.poolMax,
    idleTimeoutMs: 30_000,
    acquireTimeoutMs: 10_000,
  });

  const storage: Storage =
    config.storage.provider === "s3"
      ? new S3Storage({
          endpoint: config.storage.s3Endpoint,
          bucket: config.storage.s3Bucket,
          accessKey: config.storage.s3AccessKey,
          secretKey: config.storage.s3SecretKey,
          region: config.storage.s3Region,
        })
      : new FilesystemStorage(config.storage.root);

  const transport: Transport =
    config.notifications.provider === "smtp"
      ? new ChannelRouter(
          {
            email: new SmtpTransport({
              host: config.notifications.smtpHost,
              port: config.notifications.smtpPort,
              user: config.notifications.smtpUser,
              password: config.notifications.smtpPassword,
              fromAddress: config.notifications.fromAddress,
              fromName: config.notifications.fromName,
            }),
            sms:
              config.notifications.smsProvider === "http"
                ? new HttpSmsTransport(config.notifications.smsEndpoint, config.notifications.smsToken)
                : new ConsoleTransport(path.join(config.storage.root, "notifications"), (m) => log("info", m)),
          },
          new ConsoleTransport(path.join(config.storage.root, "notifications"), (m) => log("info", m)),
        )
      : new ConsoleTransport(path.join(config.storage.root, "notifications"), (m) => log("info", m));

  /**
   * The mock provider's asynchronous events — a settlement four seconds later,
   * a return four seconds after that — arrive here and take exactly the same
   * path a real webhook does, minus the HTTP hop. Feeding them through
   * `reconcile` rather than through a shortcut is what makes the failure paths
   * genuinely exercised rather than merely simulated.
   */
  const handleSimulatedEvent = async (event: ProviderEvent, attempt = 0): Promise<void> => {
    try {
      const outcome = await withContext(pool, SYSTEM_CONTEXT, async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO webhook_events (provider, provider_event_id, event_type, payload, signature_valid)
           VALUES ('mock', $1, $2, $3::jsonb, true)
           ON CONFLICT (provider, provider_event_id) DO NOTHING`,
          [event.providerEventId, event.type, JSON.stringify(event.raw)],
        );
        if (inserted.rowCount === 0) return null;

        const result = await reconcile(tx, event);

        // The payment this event names has not committed yet. Undo the receipt
        // record so the retry below can process the event properly rather than
        // finding it already marked seen.
        if (result.action === "unknown_payment") {
          await tx.query(
            "DELETE FROM webhook_events WHERE provider = 'mock' AND provider_event_id = $1",
            [event.providerEventId],
          );
          return result;
        }

        for (const notification of result.notify) {
          await emit(tx, {
            eventType: notification.eventType as EventType,
            dedupeKey: notification.dedupeKey,
            tenancyId: result.payment?.tenancyId ?? null,
            payload: notification.payload,
          });
        }
        await tx.query(
          "UPDATE webhook_events SET processed_at = now() WHERE provider = 'mock' AND provider_event_id = $1",
          [event.providerEventId],
        );
        return result;
      });

      if (!outcome) return;

      // A provider event can, rarely, arrive before the transaction that
      // created the payment has committed. Retrying briefly is the difference
      // between a settled payment and one that stays pending forever; giving up
      // after a bounded number of attempts is the difference between that and
      // an infinite loop over an event that names nothing real.
      if (outcome.action === "unknown_payment") {
        if (attempt < 5) {
          setTimeout(() => void handleSimulatedEvent(event, attempt + 1), 200 * (attempt + 1)).unref?.();
          return;
        }
        log("warn", "a simulated event named a payment that never appeared", {
          eventId: event.providerEventId,
          reference: event.providerReference,
        });
        return;
      }

      log("info", `simulated ${event.type} -> ${outcome.action}`, { paymentId: outcome.payment?.id });
    } catch (error) {
      log("error", "failed to apply a simulated payment event", { error: (error as Error).message });
    }
  };

  const payments: PaymentProvider =
    config.payments.provider === "stripe"
      ? new StripePaymentProvider({
          secretKey: config.payments.stripeSecretKey,
          webhookSecret: config.payments.stripeWebhookSecret,
        })
      : new MockPaymentProvider({
          settleMs: config.payments.mockAchSettleMs,
          returnRate: config.payments.mockAchReturnRate,
          secret: config.session.secret,
          emit: (event) => void handleSimulatedEvent(event),
        });

  const sessions = new SessionStore(pool, {
    secret: config.session.secret,
    ttlSeconds: config.session.ttlSeconds,
    rotateAfterSeconds: config.session.rotateAfterSeconds,
  });

  const router = new Router();
  registerAuthRoutes(router, { pool, sessions, config, transport, log });
  registerTenantRoutes(router, { pool, config, payments, storage });
  registerManagerRoutes(router, { pool, config });
  registerMessageRoutes(router, { pool });
  registerPortfolioRoutes(router, pool, { storage });
  registerWebhookRoutes(router, { pool, payments, log });
  registerStaticRoutes(router, {
    webRoot: path.resolve(HERE, "../../web"),
    sharedRoot: path.resolve(HERE, "../../../packages/shared/src"),
    production: config.env === "production",
  });

  const jobs = new JobRunner(pool, { config, payments, transport, log });
  const server = createServer({ config, router, sessions, log });

  return {
    config,
    pool,
    router,
    sessions,
    payments,
    transport,
    storage,
    jobs,
    server,

    async listen() {
      // The application does not migrate itself. Its database role has no
      // CREATE on the schema, on purpose — the process that serves requests
      // should not also be the process that can rewrite the constraints it runs
      // under. Migrations are an operator step, run as the owning role.
      const pending = await pendingMigrations(pool, config.paths.migrations);
      if (pending.length > 0) {
        throw new Error(
          `${pending.length} migration(s) have not been applied: ${pending.join(", ")}. ` +
            `Run them as the database owner first:  node src/main.ts migrate`,
        );
      }

      // Checked at every boot, not once at install. The single worst
      // misconfiguration this system has — connecting as a superuser, which
      // silently disables every isolation policy — becomes a refusal to start
      // rather than a breach nobody notices.
      const problems = await verifySecurityPosture(pool);
      if (problems.length > 0) {
        for (const problem of problems) log("error", `security posture: ${problem}`);
        if (config.env === "production") {
          throw new Error(
            `refusing to start: ${problems.length} security posture problem(s). See the log above.`,
          );
        }
        log("warn", "continuing despite security posture problems because this is not production");
      }

      if (config.jobs.enabled) jobs.start(config.jobs.intervalMs);

      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : config.port);
        });
      });

      log("info", `resident portal listening on http://${config.host}:${port}`, {
        env: config.env,
        payments: payments.name,
        simulated: payments.isSimulated,
        notifications: transport.name,
        storage: storage.name,
      });

      return { port };
    },

    async close() {
      jobs.stop();
      if (payments instanceof MockPaymentProvider) payments.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
