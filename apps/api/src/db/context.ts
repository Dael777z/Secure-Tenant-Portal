/**
 * Request context: the bridge between "who is asking" and what the database
 * will let them see.
 *
 * This is the highest-consequence file in the API. Every read and write of
 * resident data goes through `withContext`, which opens a transaction, stamps
 * the caller's identity onto it with transaction-local settings, and hands the
 * caller a handle that can do nothing else. The Row-Level Security policies in
 * migration 007 bind against exactly those settings.
 *
 * Three properties are load-bearing:
 *
 *   Transaction-local. `set_config(..., is_local => true)` discards the setting
 *   at COMMIT or ROLLBACK. On a pooled connection this is the difference between
 *   a security context and a security incident: a session-level SET would
 *   outlive the request and the next resident to borrow that connection would
 *   inherit it.
 *
 *   Bound, not interpolated. The identity values arrive as bind parameters to
 *   set_config(), so a crafted identifier cannot become SQL. `SET x = '...'`
 *   takes no parameters, which is precisely why it is not used here.
 *
 *   No default. A context with no user id and no role produces a role of 'none',
 *   which every policy in 007 refuses. The failure mode of forgetting to
 *   authenticate is an empty result set, not an unfiltered one.
 */

import type { Connection, QueryResult } from "./connection.ts";
import type { Pool } from "./pool.ts";
import { PostgresError } from "./protocol.ts";

export type ContextRole = "tenant" | "staff" | "manager" | "owner" | "system_job";

export interface RequestContext {
  userId: string | null;
  role: ContextRole;
  organizationId: string | null;
}

/**
 * The context used by the scheduled job runner, which posts charges and accrues
 * fees on behalf of no person. It is a named role rather than a superuser
 * connection so that rows it writes still record that a job wrote them, and so
 * that its use is visible in review rather than implied by a connection string.
 */
export const SYSTEM_CONTEXT: RequestContext = {
  userId: null,
  role: "system_job",
  organizationId: null,
};

/** A handle scoped to one transaction with one identity stamped on it. */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Exactly one row, or an error. For lookups where zero rows is a bug. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  /** At most one row. */
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  many<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  readonly context: RequestContext;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

function makeTx(connection: Connection, context: RequestContext): Tx {
  const query = <T>(sql: string, params: unknown[] = []) => connection.query<T>(sql, params);

  return {
    context,
    query,
    async one<T>(sql: string, params: unknown[] = []): Promise<T> {
      const result = await connection.query<T>(sql, params);
      if (result.rows.length !== 1) {
        // A query that should return one row and returns none is, in this
        // system, most often RLS correctly denying access rather than missing
        // data. The distinction matters to the caller, not to the resident, so
        // the HTTP layer renders both as 404.
        throw new NotFoundError(`expected exactly one row, received ${result.rows.length}`);
      }
      return result.rows[0];
    },
    async maybeOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await connection.query<T>(sql, params);
      if (result.rows.length > 1) {
        throw new Error(`expected at most one row, received ${result.rows.length}`);
      }
      return result.rows[0] ?? null;
    },
    async many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await connection.query<T>(sql, params);
      return result.rows;
    },
  };
}

/**
 * Run `work` inside a transaction stamped with `context`. Commits on success,
 * rolls back on any thrown error, and always clears the connection's identity
 * before returning it to the pool.
 */
export async function withContext<T>(
  pool: Pool,
  context: RequestContext,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const connection = await pool.acquire();
  connection.inExplicitTransaction = true;

  try {
    await connection.query("BEGIN");

    // is_local = true: these die with the transaction. This is the property
    // that makes pooling safe.
    await connection.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
    await connection.query("SELECT set_config('app.role', $1, true)", [context.role]);
    await connection.query("SELECT set_config('app.org_id', $1, true)", [
      context.organizationId ?? "",
    ]);

    const result = await work(makeTx(connection, context));
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch {
      // If ROLLBACK itself fails the connection is unusable; release() below
      // will discard it rather than return it to the pool.
    }
    throw error;
  } finally {
    connection.inExplicitTransaction = false;
    pool.release(connection);
  }
}

/**
 * A read-only transaction. Used for every GET path.
 *
 * This is not an optimization. It means that a bug in a read handler — a stray
 * INSERT, a mistaken UPDATE — is refused by the database rather than committed,
 * which is worth having on the paths that a resident hits most often and that
 * receive the least scrutiny in review.
 */
export async function withReadOnlyContext<T>(
  pool: Pool,
  context: RequestContext,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const connection = await pool.acquire();
  connection.inExplicitTransaction = true;

  try {
    await connection.query("BEGIN READ ONLY");
    await connection.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
    await connection.query("SELECT set_config('app.role', $1, true)", [context.role]);
    await connection.query("SELECT set_config('app.org_id', $1, true)", [
      context.organizationId ?? "",
    ]);
    const result = await work(makeTx(connection, context));
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch {
      /* discarded below */
    }
    throw error;
  } finally {
    connection.inExplicitTransaction = false;
    pool.release(connection);
  }
}

/**
 * Run work with no security context at all: role 'none', which every policy in
 * 007 refuses. Used only for authentication, where the caller is by definition
 * not yet anybody, and for schema-level bookkeeping.
 *
 * The tables it must reach — `users` and `sessions` during login — are reachable
 * because of the grants in 008 and the deliberately permissive sessions policy,
 * not because this bypasses anything.
 */
export async function withoutContext<T>(pool: Pool, work: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(pool, { userId: null, role: "system_job", organizationId: null }, work);
}

/**
 * Translate a database refusal into the error the HTTP layer should render.
 * Kept here so that "the database said no" is interpreted in one place rather
 * than guessed at in twenty route handlers.
 */
export function describeDatabaseRefusal(error: unknown): string | null {
  if (!(error instanceof PostgresError)) return null;
  if (error.isAppendOnlyViolation) {
    return "That record is append-only. Correct it by posting a reversing entry instead.";
  }
  if (error.isRlsViolation || error.isPermissionDenied) {
    return "You do not have access to that record.";
  }
  if (error.isUniqueViolation) {
    return "That record already exists.";
  }
  if (error.isCheckViolation) {
    return error.fields.message ?? "That change is not allowed by the rules of the ledger.";
  }
  return null;
}
