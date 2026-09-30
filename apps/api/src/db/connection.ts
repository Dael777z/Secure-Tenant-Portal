/**
 * A single PostgreSQL connection: startup, authentication, and the extended
 * query protocol.
 *
 * Queries are serialized onto the connection. That is not a limitation to work
 * around — it is required by the protocol, and it is exactly what makes
 * `SET LOCAL` transaction context safe. Two interleaved queries on one socket
 * could see each other's session settings, and in this system session settings
 * are what decide whose rent record you are allowed to read.
 */

import net from "node:net";
import tls from "node:tls";
import {
  BufferReader,
  MessageFramer,
  MessageWriter,
  PostgresError,
  ScramClient,
  md5Password,
  parseErrorResponse,
} from "./protocol.ts";
import { decodeValue, encodeParam } from "./types.ts";

export interface ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
}

export interface FieldDescription {
  name: string;
  dataTypeOid: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  fields: FieldDescription[];
  rowCount: number;
  command: string;
}

type Waiter = {
  resolve: (result: QueryResult) => void;
  reject: (error: Error) => void;
  rows: unknown[][];
  fields: FieldDescription[];
  command: string;
  rowCount: number;
  failure: Error | null;
};

const PROTOCOL_VERSION = 196608; // 3.0

export class Connection {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private readonly framer = new MessageFramer();
  private readonly options: ConnectionOptions;

  private connected = false;
  private closing = false;
  private current: Waiter | null = null;
  private queue: Array<() => void> = [];
  private busy = false;

  private handshake: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private scram: ScramClient | null = null;

  /** Server parameters, e.g. server_version. Useful in diagnostics. */
  readonly serverParameters: Record<string, string> = {};

  /** Set when the connection has been used inside a transaction that failed. */
  private poisoned = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  get isUsable(): boolean {
    return this.connected && !this.closing && !this.poisoned;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const socket = await this.openSocket();
    this.socket = socket;
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => this.onFatal(error));
    socket.on("close", () => {
      this.connected = false;
      if (!this.closing) this.onFatal(new Error("database connection closed unexpectedly"));
    });

    await new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
      const startup = new MessageWriter()
        .int32(PROTOCOL_VERSION)
        .cstring("user").cstring(this.options.user)
        .cstring("database").cstring(this.options.database)
        .cstring("application_name").cstring(this.options.applicationName)
        // Ask the server for ISO dates and UTC so that decoding never depends on
        // the operating system locale of whichever machine this runs on.
        .cstring("DateStyle").cstring("ISO, MDY")
        .cstring("TimeZone").cstring("UTC")
        .cstring("client_encoding").cstring("UTF8")
        .byte(0)
        .finish();
      socket.write(startup);
    });

    this.connected = true;

    // A query that runs forever holds a connection forever. Bound it at the
    // server so that a pathological plan cannot exhaust the pool.
    if (this.options.statementTimeoutMs > 0) {
      await this.query(`SET statement_timeout = ${Number(this.options.statementTimeoutMs)}`);
    }
  }

  private openSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const plain = net.connect({ host: this.options.host, port: this.options.port });
      const timer = setTimeout(() => {
        plain.destroy();
        reject(new Error(`timed out connecting to ${this.options.host}:${this.options.port}`));
      }, this.options.connectTimeoutMs);

      plain.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      plain.once("connect", () => {
        if (!this.options.ssl) {
          clearTimeout(timer);
          resolve(plain);
          return;
        }

        // SSLRequest: the magic code 80877103, then one byte of answer.
        const request = Buffer.allocUnsafe(8);
        request.writeInt32BE(8, 0);
        request.writeInt32BE(80877103, 4);
        plain.write(request);

        plain.once("data", (answer: Buffer) => {
          clearTimeout(timer);
          if (answer[0] !== 0x53) {
            plain.destroy();
            reject(new Error("server refused TLS but PGSSL is required by configuration"));
            return;
          }
          const secure = tls.connect({ socket: plain, servername: this.options.host });
          secure.once("secureConnect", () => resolve(secure));
          secure.once("error", reject);
        });
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Query execution
   * ---------------------------------------------------------------- */

  /**
   * Run a parameterized statement. `params` are bound by the server; they are
   * never interpolated into the SQL text, which is what makes injection
   * structurally impossible here rather than a discipline.
   */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (this.closing) throw new Error("connection is closing");
    await this.acquire();
    try {
      return (await this.execute(sql, params)) as QueryResult<T>;
    } finally {
      this.release();
    }
  }

  /**
   * Run SQL through the simple query protocol, which permits several statements
   * in one message. Used only for migrations and DDL scripts.
   *
   * It takes no parameters — that is a property of the protocol, not an
   * oversight — so it must never be handed anything user-supplied. Everything
   * that touches a request goes through `query()` with bound parameters, where
   * injection is structurally impossible rather than merely avoided.
   */
  async simpleQuery(sql: string): Promise<QueryResult> {
    if (this.closing) throw new Error("connection is closing");
    await this.acquire();
    try {
      return await new Promise<QueryResult>((resolve, reject) => {
        this.current = {
          resolve, reject, rows: [], fields: [], command: "", rowCount: 0, failure: null,
        };
        this.socket?.write(new MessageWriter().cstring(sql).finish("Q"));
      });
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.busy = true;
        resolve();
      });
    });
  }

  private release(): void {
    this.busy = false;
    const next = this.queue.shift();
    if (next) next();
  }

  private execute(sql: string, params: unknown[]): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      this.current = {
        resolve,
        reject,
        rows: [],
        fields: [],
        command: "",
        rowCount: 0,
        failure: null,
      };

      const encoded = params.map(encodeParam);

      // Parse: an unnamed prepared statement. Parameter types are left
      // unspecified (0) so the server infers them from context, which is what
      // lets `$1` be a uuid in one place and text in another without the client
      // having to carry a type table.
      const parse = new MessageWriter()
        .cstring("")
        .cstring(sql)
        .int16(0)
        .finish("P");

      const bind = new MessageWriter();
      bind.cstring("").cstring("");
      bind.int16(0); // all parameters in text format
      bind.int16(encoded.length);
      for (const value of encoded) {
        if (value === null) {
          bind.int32(-1);
        } else {
          const bytes = Buffer.from(value, "utf8");
          bind.int32(bytes.length).raw(bytes);
        }
      }
      bind.int16(0); // all results in text format

      const describe = new MessageWriter().byte(0x50).cstring("").finish("D"); // 'P' = portal
      const exec = new MessageWriter().cstring("").int32(0).finish("E");
      const sync = new MessageWriter().finish("S");

      this.socket?.write(Buffer.concat([parse, bind.finish("B"), describe, exec, sync]));
    });
  }

  /* ---------------------------------------------------------------- *
   * Message handling
   * ---------------------------------------------------------------- */

  private onData(chunk: Buffer): void {
    this.framer.push(chunk);
    try {
      for (const message of this.framer.drain()) {
        this.onMessage(message.type, message.body);
      }
    } catch (error) {
      this.onFatal(error as Error);
    }
  }

  private onMessage(type: string, body: Buffer): void {
    switch (type) {
      case "R":
        this.onAuthentication(body);
        break;

      case "S": {
        const reader = new BufferReader(body);
        this.serverParameters[reader.cstring()] = reader.cstring();
        break;
      }

      case "K": // BackendKeyData — only needed for out-of-band cancellation.
      case "1": // ParseComplete
      case "2": // BindComplete
      case "3": // CloseComplete
      case "n": // NoData
      case "t": // ParameterDescription
        break;

      case "T": {
        const reader = new BufferReader(body);
        const count = reader.int16();
        const fields: FieldDescription[] = [];
        for (let i = 0; i < count; i += 1) {
          const name = reader.cstring();
          reader.int32(); // table oid
          reader.int16(); // column attnum
          const dataTypeOid = reader.int32();
          reader.int16(); // type size
          reader.int32(); // type modifier
          reader.int16(); // format code
          fields.push({ name, dataTypeOid });
        }
        if (this.current) this.current.fields = fields;
        break;
      }

      case "D": {
        if (!this.current) break;
        const reader = new BufferReader(body);
        const count = reader.int16();
        const row: unknown[] = [];
        for (let i = 0; i < count; i += 1) {
          const length = reader.int32();
          row.push(length === -1 ? null : reader.bytes(length).toString("utf8"));
        }
        this.current.rows.push(row);
        break;
      }

      case "C": {
        if (!this.current) break;
        const tag = new BufferReader(body).cstring();
        const parts = tag.split(" ");
        this.current.command = parts[0];
        // INSERT reports "INSERT <oid> <count>"; everything else "<CMD> <count>".
        const count = Number(parts[parts.length - 1]);
        this.current.rowCount = Number.isFinite(count) ? count : 0;
        break;
      }

      case "I": // EmptyQueryResponse
        if (this.current) this.current.command = "EMPTY";
        break;

      case "E": {
        const error = new PostgresError(parseErrorResponse(body));
        if (this.handshake) {
          const { reject } = this.handshake;
          this.handshake = null;
          reject(error);
        } else if (this.current) {
          // Hold the failure until ReadyForQuery so the connection is returned
          // to a known state before the caller sees the rejection.
          this.current.failure = error;
        }
        break;
      }

      case "N": // NoticeResponse — RAISE NOTICE and friends. Not an error.
        break;

      case "Z": {
        const status = String.fromCharCode(body[0]);
        // 'E' means the transaction is aborted; the connection must not be
        // handed back to the pool as if it were clean.
        this.poisoned = status === "E" && !this.inExplicitTransaction;

        if (this.handshake) {
          const { resolve } = this.handshake;
          this.handshake = null;
          resolve();
          break;
        }

        const waiter = this.current;
        this.current = null;
        if (!waiter) break;

        if (waiter.failure) {
          waiter.reject(waiter.failure);
          break;
        }

        const rows = waiter.rows.map((values) => {
          const record: Record<string, unknown> = {};
          waiter.fields.forEach((field, index) => {
            record[field.name] = decodeValue(values[index] as string | null, field.dataTypeOid);
          });
          return record;
        });

        waiter.resolve({
          rows,
          fields: waiter.fields,
          rowCount: waiter.command === "SELECT" ? rows.length : waiter.rowCount,
          command: waiter.command,
        });
        break;
      }

      case "A": // NotificationResponse (LISTEN/NOTIFY) — unused here.
        break;

      default:
        break;
    }
  }

  /** Set while a caller holds an explicit BEGIN, so 'Z' with 'E' is expected. */
  inExplicitTransaction = false;

  private onAuthentication(body: Buffer): void {
    const reader = new BufferReader(body);
    const code = reader.int32();

    switch (code) {
      case 0: // AuthenticationOk
        return;

      case 3: { // cleartext
        const message = new MessageWriter().cstring(this.options.password).finish("p");
        this.socket?.write(message);
        return;
      }

      case 5: { // MD5
        const salt = reader.bytes(4);
        const hashed = md5Password(this.options.user, this.options.password, salt);
        this.socket?.write(new MessageWriter().cstring(hashed).finish("p"));
        return;
      }

      case 10: { // SASL
        const mechanisms: string[] = [];
        while (reader.remaining > 1) {
          const name = reader.cstring();
          if (!name) break;
          mechanisms.push(name);
        }
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          this.failHandshake(
            new Error(`server offered only ${mechanisms.join(", ") || "no"} SASL mechanisms`),
          );
          return;
        }

        this.scram = new ScramClient(this.options.password);
        const first = Buffer.from(this.scram.clientFirstMessage(), "utf8");
        const message = new MessageWriter()
          .cstring("SCRAM-SHA-256")
          .int32(first.length)
          .raw(first)
          .finish("p");
        this.socket?.write(message);
        return;
      }

      case 11: { // SASLContinue
        if (!this.scram) return this.failHandshake(new Error("unexpected SASL continue"));
        const serverFirst = reader.rest().toString("utf8");
        const final = this.scram.clientFinalMessage(serverFirst);
        this.socket?.write(new MessageWriter().raw(Buffer.from(final, "utf8")).finish("p"));
        return;
      }

      case 12: { // SASLFinal
        if (!this.scram) return this.failHandshake(new Error("unexpected SASL final"));
        try {
          this.scram.verifyServerFinal(reader.rest().toString("utf8"));
        } catch (error) {
          this.failHandshake(error as Error);
        }
        return;
      }

      default:
        this.failHandshake(new Error(`unsupported authentication method (code ${code})`));
    }
  }

  private failHandshake(error: Error): void {
    if (this.handshake) {
      const { reject } = this.handshake;
      this.handshake = null;
      reject(error);
    }
  }

  private onFatal(error: Error): void {
    this.connected = false;
    this.poisoned = true;
    if (this.handshake) {
      const { reject } = this.handshake;
      this.handshake = null;
      reject(error);
    }
    if (this.current) {
      const waiter = this.current;
      this.current = null;
      waiter.reject(error);
    }
    const pending = this.queue.splice(0);
    for (const resume of pending) resume();
  }

  async end(): Promise<void> {
    this.closing = true;
    if (this.socket && this.connected) {
      try {
        this.socket.write(new MessageWriter().finish("X")); // Terminate
      } catch {
        // The socket may already be gone; closing is best-effort.
      }
    }
    this.socket?.destroy();
    this.connected = false;
  }
}
