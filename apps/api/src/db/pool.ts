/**
 * A connection pool.
 *
 * Pooling and per-request security context interact in a way that deserves to
 * be stated plainly, because getting it wrong leaks one resident's data to
 * another: connections are reused across requests, so anything set on a
 * connection outlives the request that set it unless it is scoped to a
 * transaction. Every context setting in this system is applied with
 * `set_config(..., is_local => true)` inside an explicit transaction, so it is
 * discarded at COMMIT or ROLLBACK — see context.ts. This file's contribution is
 * the other half: a connection that ends a checkout in any unexpected state is
 * destroyed rather than reused.
 */

import { Connection, type ConnectionOptions, type QueryResult } from "./connection.ts";

export interface PoolOptions extends ConnectionOptions {
  max: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

interface Entry {
  connection: Connection;
  idleSince: number;
  leased: boolean;
}

export class Pool {
  private readonly options: PoolOptions;
  private readonly entries: Entry[] = [];
  private readonly waiting: Array<{
    resolve: (entry: Entry) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private reaper: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: PoolOptions) {
    this.options = options;
  }

  get size(): number {
    return this.entries.length;
  }

  get leased(): number {
    return this.entries.filter((e) => e.leased).length;
  }

  async acquire(): Promise<Connection> {
    const entry = await this.acquireEntry();
    return entry.connection;
  }

  private async acquireEntry(): Promise<Entry> {
    if (this.closed) throw new Error("pool is closed");

    const idle = this.entries.find((e) => !e.leased && e.connection.isUsable);
    if (idle) {
      idle.leased = true;
      return idle;
    }

    // Drop anything that died while idle before deciding we are at capacity.
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (!entry.leased && !entry.connection.isUsable) {
        void entry.connection.end();
        this.entries.splice(i, 1);
      }
    }

    if (this.entries.length < this.options.max) {
      const connection = new Connection(this.options);
      const entry: Entry = { connection, idleSince: Date.now(), leased: true };
      this.entries.push(entry);
      try {
        await connection.connect();
      } catch (error) {
        this.entries.splice(this.entries.indexOf(entry), 1);
        throw error;
      }
      this.startReaper();
      return entry;
    }

    return new Promise<Entry>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(
          new Error(
            `timed out waiting ${this.options.acquireTimeoutMs}ms for a database connection ` +
              `(${this.leased}/${this.options.max} in use)`,
          ),
        );
      }, this.options.acquireTimeoutMs);
      this.waiting.push({ resolve, reject, timer });
    });
  }

  release(connection: Connection): void {
    const entry = this.entries.find((e) => e.connection === connection);
    if (!entry) return;

    // A connection that is no longer usable — a socket error, an aborted
    // transaction — must never be handed to the next request, which might be a
    // different resident.
    if (!connection.isUsable) {
      void connection.end();
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      this.pumpWaiters();
      return;
    }

    entry.leased = false;
    entry.idleSince = Date.now();

    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      entry.leased = true;
      next.resolve(entry);
    }
  }

  private pumpWaiters(): void {
    if (this.waiting.length === 0) return;
    // Capacity freed up; let the next waiter try to open a fresh connection.
    const next = this.waiting.shift();
    if (!next) return;
    clearTimeout(next.timer);
    this.acquireEntry().then(next.resolve, next.reject);
  }

  /** One-shot query outside any transaction. Used for health checks and reads
   *  that carry no security context, never for resident data. */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const connection = await this.acquire();
    try {
      return await connection.query<T>(sql, params);
    } finally {
      this.release(connection);
    }
  }

  private startReaper(): void {
    if (this.reaper || this.options.idleTimeoutMs <= 0) return;
    this.reaper = setInterval(() => {
      const cutoff = Date.now() - this.options.idleTimeoutMs;
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const entry = this.entries[i];
        // Keep one connection warm so that a quiet system does not pay
        // handshake cost on the first request after every idle period.
        if (!entry.leased && entry.idleSince < cutoff && this.entries.length > 1) {
          void entry.connection.end();
          this.entries.splice(i, 1);
        }
      }
    }, Math.max(1000, this.options.idleTimeoutMs / 2));
    this.reaper.unref?.();
  }

  async end(): Promise<void> {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("pool is closing"));
    }
    await Promise.all(this.entries.splice(0).map((e) => e.connection.end()));
  }
}
