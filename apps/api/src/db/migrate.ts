/**
 * Migration runner.
 *
 * Files in `migrations/` run once each, in filename order, inside a transaction,
 * recorded by checksum. The checksum is the point: a migration whose text has
 * changed since it was applied is a schema that no longer matches its own
 * history, and on a system where the schema *is* the security model that is a
 * failure to stop on rather than warn about.
 *
 * Migrations run as the owning role, not as `portal_app` — the application role
 * deliberately cannot alter the structures that constrain it.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "./pool.ts";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0
  )
`;

export async function migrate(
  pool: Pool,
  directory: string,
  log: (message: string) => void = () => {},
): Promise<MigrationResult> {
  const connection = await pool.acquire();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await connection.query(TRACKING_TABLE);

    const existing = await connection.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const known = new Map(existing.rows.map((r) => [r.filename, r.checksum]));

    const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();

    for (const filename of files) {
      const sql = await readFile(path.join(directory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 32);
      const previous = known.get(filename);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `migration ${filename} has changed since it was applied ` +
              `(recorded ${previous}, found ${checksum}). ` +
              `Add a new migration rather than editing an applied one.`,
          );
        }
        skipped.push(filename);
        continue;
      }

      const started = Date.now();
      log(`applying ${filename}`);
      connection.inExplicitTransaction = true;
      try {
        await connection.query("BEGIN");
        // Migration files hold many statements, which the extended query
        // protocol cannot carry in one message.
        await connection.simpleQuery(sql);
        await connection.query(
          "INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)",
          [filename, checksum, Date.now() - started],
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${filename} failed: ${(error as Error).message}`, { cause: error });
      } finally {
        connection.inExplicitTransaction = false;
      }
      applied.push(filename);
    }
  } finally {
    pool.release(connection);
  }

  return { applied, skipped };
}

/**
 * Which migrations have not been applied.
 *
 * Read-only, so the application role can run it even though it deliberately
 * cannot apply migrations. The server calls this at boot and refuses to start
 * against a schema it does not recognize, rather than trying to fix it: on a
 * system where the schema *is* the security model, a process that can rewrite
 * that schema at startup is a process with more authority than it should have.
 */
export async function pendingMigrations(pool: Pool, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();

  let applied: Set<string>;
  try {
    const rows = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    applied = new Set(rows.rows.map((r) => r.filename));
  } catch {
    // No tracking table at all: nothing has ever been applied here.
    return files;
  }

  return files.filter((f) => !applied.has(f));
}

/**
 * Assert the properties the security model depends on, at boot, every boot.
 *
 * A deployment where the application connects as a superuser is a deployment
 * where none of the Row-Level Security in migration 007 does anything at all,
 * and it fails open and silently. Checking at startup turns the worst
 * misconfiguration this system has into a refusal to start.
 */
export async function verifySecurityPosture(pool: Pool): Promise<string[]> {
  const problems: string[] = [];

  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const me = role.rows[0];

  if (me?.rolsuper) {
    problems.push(
      `the application is connected as superuser '${me.rolname}', which bypasses every ` +
        `Row-Level Security policy in this database. Connect as portal_app instead.`,
    );
  }
  if (me?.rolbypassrls) {
    problems.push(
      `role '${me.rolname}' has BYPASSRLS, which disables resident data isolation. ` +
        `Run: ALTER ROLE ${me.rolname} NOBYPASSRLS;`,
    );
  }

  // Every table holding resident data must have RLS enabled *and* forced.
  // Without FORCE, the owner silently bypasses its own policies.
  const rls = await pool.query<{ tablename: string; rowsecurity: boolean; forced: boolean }>(`
    SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (
        'ledger_entries','payments','payment_methods','tenancies','work_orders',
        'work_order_events','work_order_photos','charge_disputes','payment_plans',
        'notification_deliveries','audit_log','users','password_reset_tokens'
      )
  `);

  for (const table of rls.rows) {
    if (!table.rowsecurity) problems.push(`table ${table.tablename} does not have RLS enabled`);
    else if (!table.forced) problems.push(`table ${table.tablename} has RLS but not FORCE ROW LEVEL SECURITY`);
  }

  // The ledger's append-only guarantee, checked rather than assumed.
  const ledgerGrants = await pool.query<{ can_update: boolean; can_delete: boolean }>(`
    SELECT has_table_privilege(current_user, 'ledger_entries', 'UPDATE') AS can_update,
           has_table_privilege(current_user, 'ledger_entries', 'DELETE') AS can_delete
  `);
  if (ledgerGrants.rows[0]?.can_update || ledgerGrants.rows[0]?.can_delete) {
    problems.push(
      "the application role holds UPDATE or DELETE on ledger_entries; the ledger is meant to be append-only",
    );
  }

  const trigger = await pool.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM pg_trigger
    WHERE tgrelid = 'ledger_entries'::regclass AND NOT tgisinternal
  `);
  if ((trigger.rows[0]?.count ?? 0) < 2) {
    problems.push("ledger_entries is missing its append-only guard triggers");
  }

  return problems;
}
