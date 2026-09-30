/**
 * Configuration, read once from the environment at boot.
 *
 * Two rules. Secrets have no defaults — a system that silently starts with a
 * development signing key in production is a system with no sessions worth
 * having. And configuration is validated at startup rather than at first use, so
 * a typo in an env var is a refusal to boot rather than a 500 at 2am on the
 * first of the month.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type Environment = "development" | "test" | "production";

export interface Config {
  env: Environment;
  port: number;
  host: string;
  publicUrl: string;

  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
    poolMax: number;
    statementTimeoutMs: number;
  };

  session: {
    secret: string;
    ttlSeconds: number;
    /** Re-issue a token once it is this far through its life. */
    rotateAfterSeconds: number;
    cookieName: string;
    secureCookies: boolean;
  };

  /** IANA zone the property operates in; decides what "today" means for due dates and fees. */
  timeZone: string;

  payments: {
    provider: "mock" | "stripe";
    /**
     * Whether residents may add or pay with a card. Off by default: the sponsor
     * asked for bank transfers only (9/27 meeting). Turning it on changes no
     * code path — the card flow is still implemented and tested.
     */
    allowCards: boolean;
    stripeSecretKey: string;
    stripeWebhookSecret: string;
    plaidClientId: string;
    plaidSecret: string;
    plaidEnvironment: string;
    /** Mock only: how long a simulated ACH debit takes to settle. */
    mockAchSettleMs: number;
    /** Mock only: fraction of ACH debits returned after settlement, 0–1. */
    mockAchReturnRate: number;
  };

  notifications: {
    provider: "console" | "smtp";
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    fromAddress: string;
    fromName: string;
    smsProvider: "console" | "http";
    smsEndpoint: string;
    smsToken: string;
  };

  storage: {
    provider: "filesystem" | "s3";
    root: string;
    s3Endpoint: string;
    s3Bucket: string;
    s3AccessKey: string;
    s3SecretKey: string;
    s3Region: string;
    signedUrlTtlSeconds: number;
  };

  jobs: {
    enabled: boolean;
    intervalMs: number;
  };

  paths: {
    migrations: string;
    web: string;
    uploads: string;
  };

  security: {
    /**
     * Test-only. Disables the application's own tenancy filters so that the
     * cross-tenant probe suite measures the database rather than the
     * application. Refused outright outside the test environment: a suite that
     * can only run with a production-capable flag is a footgun, not a test.
     */
    disableApplicationFilters: boolean;
    maxFailedLogins: number;
    lockoutMinutes: number;
    rateLimitPerMinute: number;
    trustProxy: boolean;
  };
}

function required(name: string, env: Environment): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (env === "production") {
    throw new Error(`${name} must be set in production`);
  }
  return "";
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, received "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function oneOf<T extends string>(name: string, options: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!(options as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${options.join(", ")}, received "${raw}"`);
  }
  return raw as T;
}

export function loadConfig(): Config {
  const env = oneOf("NODE_ENV", ["development", "test", "production"] as const, "development");
  const isProduction = env === "production";

  const sessionSecret = required("SESSION_SECRET", env) ||
    // Development only, and regenerated on every boot so that it cannot
    // accidentally become a shared, committed, or long-lived key.
    `dev-only-${process.pid}-${Date.now()}`;

  if (isProduction && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters in production");
  }

  const paymentsProvider = oneOf("PAYMENTS_PROVIDER", ["mock", "stripe"] as const, "mock");
  if (isProduction && paymentsProvider === "mock") {
    throw new Error(
      "PAYMENTS_PROVIDER is 'mock' in production. The mock provider simulates settlement " +
        "and moves no money; set it to 'stripe' and supply STRIPE_SECRET_KEY.",
    );
  }

  const disableFilters = bool("UNSAFE_DISABLE_APPLICATION_FILTERS", false);
  if (disableFilters && env !== "test") {
    throw new Error(
      "UNSAFE_DISABLE_APPLICATION_FILTERS is only permitted with NODE_ENV=test. " +
        "It exists so the isolation suite can prove the database enforces isolation on its own.",
    );
  }

  return {
    env,
    port: num("PORT", 4000),
    host: process.env.HOST || "0.0.0.0",
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${num("PORT", 4000)}`,

    database: {
      host: process.env.PGHOST || "127.0.0.1",
      port: num("PGPORT", 5432),
      user: process.env.PGUSER || "portal_app",
      password: process.env.PGPASSWORD || "",
      database: process.env.PGDATABASE || "portal",
      ssl: bool("PGSSL", isProduction),
      poolMax: num("PG_POOL_MAX", 12),
      statementTimeoutMs: num("PG_STATEMENT_TIMEOUT_MS", 15_000),
    },

    session: {
      secret: sessionSecret,
      ttlSeconds: num("SESSION_TTL_SECONDS", 60 * 60 * 12),
      rotateAfterSeconds: num("SESSION_ROTATE_AFTER_SECONDS", 60 * 60),
      cookieName: process.env.SESSION_COOKIE_NAME || "portal_session",
      secureCookies: bool("SECURE_COOKIES", isProduction),
    },

    timeZone: process.env.PORTAL_TIMEZONE || "America/Denver",

    payments: {
      provider: paymentsProvider,
      allowCards: bool("PAYMENTS_ALLOW_CARDS", false),
      stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
      plaidClientId: process.env.PLAID_CLIENT_ID || "",
      plaidSecret: process.env.PLAID_SECRET || "",
      plaidEnvironment: process.env.PLAID_ENV || "sandbox",
      mockAchSettleMs: num("MOCK_ACH_SETTLE_MS", 4000),
      mockAchReturnRate: num("MOCK_ACH_RETURN_RATE", 0),
    },

    notifications: {
      provider: oneOf("NOTIFY_PROVIDER", ["console", "smtp"] as const, "console"),
      smtpHost: process.env.SMTP_HOST || "127.0.0.1",
      smtpPort: num("SMTP_PORT", 1025),
      smtpUser: process.env.SMTP_USER || "",
      smtpPassword: process.env.SMTP_PASSWORD || "",
      fromAddress: process.env.MAIL_FROM || "no-reply@resident-portal.local",
      fromName: process.env.MAIL_FROM_NAME || "Summit",
      smsProvider: oneOf("SMS_PROVIDER", ["console", "http"] as const, "console"),
      smsEndpoint: process.env.SMS_ENDPOINT || "",
      smsToken: process.env.SMS_TOKEN || "",
    },

    storage: {
      provider: oneOf("STORAGE_PROVIDER", ["filesystem", "s3"] as const, "filesystem"),
      root: process.env.STORAGE_ROOT || path.resolve(HERE, "../../../var/uploads"),
      s3Endpoint: process.env.S3_ENDPOINT || "",
      s3Bucket: process.env.S3_BUCKET || "resident-portal",
      s3AccessKey: process.env.S3_ACCESS_KEY || "",
      s3SecretKey: process.env.S3_SECRET_KEY || "",
      s3Region: process.env.S3_REGION || "us-east-1",
      signedUrlTtlSeconds: num("SIGNED_URL_TTL_SECONDS", 600),
    },

    jobs: {
      enabled: bool("JOBS_ENABLED", true),
      intervalMs: num("JOBS_INTERVAL_MS", 60_000),
    },

    paths: {
      migrations: process.env.MIGRATIONS_DIR || path.resolve(HERE, "../migrations"),
      web: process.env.WEB_DIR || path.resolve(HERE, "../../web"),
      uploads: process.env.STORAGE_ROOT || path.resolve(HERE, "../../../var/uploads"),
    },

    security: {
      disableApplicationFilters: disableFilters,
      maxFailedLogins: num("MAX_FAILED_LOGINS", 8),
      lockoutMinutes: num("LOCKOUT_MINUTES", 15),
      rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120),
      trustProxy: bool("TRUST_PROXY", isProduction),
    },
  };
}
