#!/usr/bin/env node
/**
 * Entry point.
 *
 * `node src/main.ts` starts the server. `node src/main.ts <command>` runs one of
 * the operational tasks below and exits, so that migrating, seeding, and
 * inspecting the route table do not require a second tool or a package script
 * that drifts out of date.
 */

import { setPortalTimeZone } from "../../../packages/shared/src/ids.ts";
import { createApplication, createLogger } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate, verifySecurityPosture } from "./db/migrate.ts";
import { Pool } from "./db/pool.ts";
import { seedBlank } from "./seed/seed.ts";

const command = process.argv[2] ?? "serve";

function poolFromConfig() {
  const config = loadConfig();
  // Jobs and the seed decide "today" the same way the server does.
  setPortalTimeZone(config.timeZone);
  return {
    config,
    pool: new Pool({
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      database: config.database.database,
      ssl: config.database.ssl,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 120_000,
      applicationName: `resident-portal-${command}`,
      max: 4,
      idleTimeoutMs: 5_000,
      acquireTimeoutMs: 10_000,
    }),
  };
}

switch (command) {
  case "serve": {
    const app = await createApplication();
    await app.listen();

    // Finish in-flight requests rather than dropping them. A payment submitted
    // half a second before a deploy should not vanish.
    const shutdown = async (signal: string) => {
      console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: `${signal} received, shutting down` }));
      await app.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
    break;
  }

  case "migrate": {
    const { config, pool } = poolFromConfig();
    const log = createLogger(config);
    const result = await migrate(pool, config.paths.migrations, (m) => log("info", m));
    console.log(`applied ${result.applied.length}, already present ${result.skipped.length}`);
    // No posture check here. Migrations run as the schema owner, which is
    // privileged by design, so checking this connection would only ever report
    // the owner being the owner - and in production it used to fail the
    // migrate step for exactly that. The check that matters is the one made
    // with the application's credentials: `check`, and serve's own boot check.
    console.log("next: run `check` with the application's credentials (PGUSER=portal_app)");
    await pool.end();
    process.exit(0);
  }

  case "seed": {
    const { config, pool } = poolFromConfig();
    const log = createLogger(config);
    await migrate(pool, config.paths.migrations, (m) => log("info", m));
    // FRIDAY TEST COPY: blank portal for live data entry (see seedBlank).
    const summary = await seedBlank(pool);
    console.log(summary);
    await pool.end();
    process.exit(0);
  }

  case "check": {
    const { pool } = poolFromConfig();
    const problems = await verifySecurityPosture(pool);
    if (problems.length === 0) {
      console.log("security posture: all checks passed");
    } else {
      for (const problem of problems) console.error(`FAIL  ${problem}`);
    }
    await pool.end();
    process.exit(problems.length === 0 ? 0 : 1);
  }

  case "routes": {
    // The route audit: every endpoint with the access rule it declares, in one
    // table a reviewer can read top to bottom.
    const app = await createApplication();
    const rows = app.router.describe();
    const width = Math.max(...rows.map((r) => r.pattern.length));
    for (const row of rows.sort((a, b) => a.pattern.localeCompare(b.pattern))) {
      console.log(`${row.method.padEnd(6)} ${row.pattern.padEnd(width)}  ${row.access}`);
    }
    console.log(`\n${rows.length} routes`);
    await app.pool.end();
    process.exit(0);
  }

  default:
    console.error(`unknown command: ${command}`);
    console.error("usage: node src/main.ts [serve|migrate|seed|check|routes]");
    process.exit(1);
}
