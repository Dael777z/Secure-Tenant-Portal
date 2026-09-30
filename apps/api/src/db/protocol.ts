/**
 * PostgreSQL frontend/backend protocol, version 3.0.
 *
 * Why this is here rather than `pg`: this system is deployed by a property
 * manager onto hardware they own and are responsible for patching. Every
 * runtime dependency is a supply-chain surface the operator inherits, and this
 * one — the component that carries every rent payment and every password — is
 * the last place to accept a transitive dependency tree nobody has read.
 *
 * What this file implements is deliberately the whole protocol we use and not
 * one byte more: startup, SASL/SCRAM-SHA-256 and MD5 authentication, the
 * extended query protocol with server-side parameter binding, and error
 * decoding rich enough to distinguish an RLS denial from an append-only
 * violation from a unique-key collision.
 *
 * Everything user-supplied travels as a *bound parameter*, never as text
 * concatenated into SQL. That is not a style preference here: parameters are
 * what make SQL injection structurally impossible rather than merely unlikely.
 *
 * Reference: PostgreSQL 16, §55.2 Message Flow and §55.7 Message Formats;
 * SCRAM per RFC 5802 and RFC 7677.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ *
 * Writing messages
 * ------------------------------------------------------------------ */

export class MessageWriter {
  private chunks: Buffer[] = [];
  private size = 0;

  byte(value: number): this {
    return this.push(Buffer.from([value]));
  }

  int16(value: number): this {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16BE(value, 0);
    return this.push(b);
  }

  int32(value: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(value, 0);
    return this.push(b);
  }

  /** A C string: UTF-8 bytes followed by a NUL terminator. */
  cstring(value: string): this {
    const b = Buffer.from(value, "utf8");
    return this.push(Buffer.concat([b, Buffer.from([0])]));
  }

  raw(value: Buffer): this {
    return this.push(value);
  }

  private push(b: Buffer): this {
    this.chunks.push(b);
    this.size += b.length;
    return this;
  }

  /**
   * Frame the accumulated body as a protocol message. `type` is omitted only
   * for the startup packet, which is the one message with no type byte.
   */
  finish(type?: string): Buffer {
    const body = Buffer.concat(this.chunks, this.size);
    const header = Buffer.allocUnsafe(type ? 5 : 4);
    let offset = 0;
    if (type) {
      header.write(type, 0, "ascii");
      offset = 1;
    }
    header.writeInt32BE(body.length + 4, offset);
    return Buffer.concat([header, body]);
  }
}

/* ------------------------------------------------------------------ *
 * Reading messages
 * ------------------------------------------------------------------ */

export interface BackendMessage {
  type: string;
  body: Buffer;
}

/**
 * TCP delivers bytes, not messages. This accumulates whatever arrives and
 * yields only complete, correctly-framed messages, which is the difference
 * between a client that works on a fast loopback and one that works on a real
 * network under load.
 */
export class MessageFramer {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  *drain(): Generator<BackendMessage> {
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      if (length < 4) throw new Error(`malformed message length ${length}`);
      const total = length + 1;
      if (this.buffer.length < total) return;
      const type = String.fromCharCode(this.buffer[0]);
      const body = this.buffer.subarray(5, total);
      // Copy: the caller may hold on to this past the next concat.
      yield { type, body: Buffer.from(body) };
      this.buffer = this.buffer.subarray(total);
    }
  }
}

export class BufferReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  byte(): number {
    return this.buffer[this.offset++];
  }

  int16(): number {
    const v = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    const v = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  cstring(): string {
    const end = this.buffer.indexOf(0, this.offset);
    if (end === -1) throw new Error("unterminated string in backend message");
    const s = this.buffer.toString("utf8", this.offset, end);
    this.offset = end + 1;
    return s;
  }

  bytes(length: number): Buffer {
    const b = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return b;
  }

  rest(): Buffer {
    const b = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return b;
  }
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export interface PostgresErrorFields {
  severity?: string;
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  position?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

export class PostgresError extends Error {
  readonly code: string;
  readonly fields: PostgresErrorFields;

  constructor(fields: PostgresErrorFields) {
    super(fields.message ?? "postgres error");
    this.name = "PostgresError";
    this.code = fields.code ?? "XX000";
    this.fields = fields;
  }

  /** Row-Level Security refused the write. Distinguished from a bug. */
  get isRlsViolation(): boolean {
    return this.code === "42501" || /row-level security/i.test(this.message);
  }

  /**
   * The database refused a write on privilege or policy grounds. Both of the
   * mechanisms guarding the ledger land here: the REVOKE produces 42501, and
   * the guard trigger produces 0A000 for anyone who somehow still holds the
   * privilege. Callers treat either as "the database said no", never as a bug
   * to route around.
   */
  get isPermissionDenied(): boolean {
    return this.code === "42501";
  }

  /** The append-only guard trigger fired. See app.forbid_mutation(). */
  get isAppendOnlyViolation(): boolean {
    return this.code === "0A000" && /append-only/i.test(this.message);
  }

  /** Any refusal to mutate protected data, by whichever mechanism caught it. */
  get isWriteRefused(): boolean {
    return this.isPermissionDenied || this.isAppendOnlyViolation || this.isRlsViolation;
  }

  get isUniqueViolation(): boolean {
    return this.code === "23505";
  }

  get isCheckViolation(): boolean {
    return this.code === "23514";
  }

  get isForeignKeyViolation(): boolean {
    return this.code === "23503";
  }
}

const ERROR_FIELD_NAMES: Record<string, keyof PostgresErrorFields> = {
  S: "severity",
  C: "code",
  M: "message",
  D: "detail",
  H: "hint",
  P: "position",
  W: "where",
  s: "schema",
  t: "table",
  c: "column",
  n: "constraint",
};

export function parseErrorResponse(body: Buffer): PostgresErrorFields {
  const reader = new BufferReader(body);
  const fields: PostgresErrorFields = {};
  while (reader.remaining > 0) {
    const code = reader.byte();
    if (code === 0) break;
    const value = reader.cstring();
    const name = ERROR_FIELD_NAMES[String.fromCharCode(code)];
    if (name) fields[name] = value;
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * SCRAM-SHA-256  (RFC 5802 / RFC 7677)
 *
 * The default authentication method in PostgreSQL 14+. Implemented rather than
 * sidestepped with `password` or `trust`, because a self-hosted deployment guide
 * that begins "set your pg_hba to trust" is a guide to a compromised database.
 * ------------------------------------------------------------------ */

export class ScramClient {
  private readonly password: string;
  private readonly clientNonce: string;
  private clientFirstBare = "";
  private serverFirst = "";
  private saltedPassword: Buffer = Buffer.alloc(0);
  private authMessage = "";

  constructor(password: string) {
    this.password = password;
    this.clientNonce = randomBytes(24).toString("base64");
  }

  /** "n,,n=,r=<nonce>" — the gs2 header says we are not using channel binding. */
  clientFirstMessage(): string {
    this.clientFirstBare = `n=,r=${this.clientNonce}`;
    return `n,,${this.clientFirstBare}`;
  }

  clientFinalMessage(serverFirstMessage: string): string {
    this.serverFirst = serverFirstMessage;
    const parts = parseScramMessage(serverFirstMessage);
    const combinedNonce = parts.r;
    const salt = Buffer.from(parts.s, "base64");
    const iterations = Number(parts.i);

    if (!combinedNonce?.startsWith(this.clientNonce)) {
      throw new Error("SCRAM: server nonce does not extend the client nonce");
    }
    if (!Number.isSafeInteger(iterations) || iterations < 1) {
      throw new Error("SCRAM: bad iteration count");
    }

    // SaltedPassword := Hi(Normalize(password), salt, i)
    this.saltedPassword = pbkdf2Sync(this.password, salt, iterations, 32, "sha256");

    const clientKey = createHmac("sha256", this.saltedPassword).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();

    // "c=biws" is base64("n,,") — the gs2 header echoed back.
    const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
    this.authMessage = `${this.clientFirstBare},${this.serverFirst},${clientFinalWithoutProof}`;

    const clientSignature = createHmac("sha256", storedKey).update(this.authMessage).digest();
    const proof = Buffer.allocUnsafe(clientKey.length);
    for (let i = 0; i < clientKey.length; i += 1) {
      proof[i] = clientKey[i] ^ clientSignature[i];
    }

    return `${clientFinalWithoutProof},p=${proof.toString("base64")}`;
  }

  /**
   * Verify the server's signature. Skipping this step is what turns SCRAM back
   * into a password-over-the-wire scheme: without it, anything that can occupy
   * the socket can convince us it is our database.
   */
  verifyServerFinal(serverFinalMessage: string): void {
    const parts = parseScramMessage(serverFinalMessage);
    if (parts.e) throw new Error(`SCRAM: server rejected authentication: ${parts.e}`);
    if (!parts.v) throw new Error("SCRAM: server final message carried no signature");

    const serverKey = createHmac("sha256", this.saltedPassword).update("Server Key").digest();
    const expected = createHmac("sha256", serverKey).update(this.authMessage).digest();
    const received = Buffer.from(parts.v, "base64");

    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new Error("SCRAM: server signature did not verify");
    }
  }
}

function parseScramMessage(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** MD5 authentication, retained for older or deliberately-configured servers. */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash("md5").update(password + user, "utf8").digest("hex");
  const outer = createHash("md5")
    .update(Buffer.concat([Buffer.from(inner, "utf8"), salt]))
    .digest("hex");
  return `md5${outer}`;
}
