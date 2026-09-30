/**
 * Decoding PostgreSQL's text-format wire values into JavaScript.
 *
 * One rule governs this file: a value that cannot be represented exactly throws
 * rather than arriving quietly wrong. A rent ledger that silently rounds is
 * worse than one that refuses to load, because the first kind of failure is
 * discovered by a resident in a demand letter and the second by an engineer in
 * a stack trace.
 */

export const OID = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  OID: 26,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
  INET: 869,
  // Array types.
  BOOL_ARRAY: 1000,
  INT2_ARRAY: 1005,
  INT4_ARRAY: 1007,
  TEXT_ARRAY: 1009,
  VARCHAR_ARRAY: 1015,
  INT8_ARRAY: 1016,
  UUID_ARRAY: 2951,
  JSONB_ARRAY: 3807,
} as const;

const INT_ARRAY_OIDS = new Set<number>([OID.INT2_ARRAY, OID.INT4_ARRAY, OID.INT8_ARRAY]);
const TEXT_ARRAY_OIDS = new Set<number>([OID.TEXT_ARRAY, OID.VARCHAR_ARRAY, OID.UUID_ARRAY]);

export function decodeValue(raw: string | null, oid: number): unknown {
  if (raw === null) return null;

  switch (oid) {
    case OID.BOOL:
      return raw === "t";

    case OID.INT2:
    case OID.INT4:
    case OID.OID:
      return Number(raw);

    case OID.INT8:
      return decodeBigInt(raw);

    case OID.FLOAT4:
    case OID.FLOAT8:
      return Number(raw);

    // `numeric` is arbitrary-precision on the server. It is used in this schema
    // only for a late-fee percentage, never for an amount of money — amounts are
    // bigint cents — so returning a float here loses nothing that matters.
    case OID.NUMERIC:
      return Number(raw);

    case OID.JSON:
    case OID.JSONB:
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }

    // Dates and timestamps stay as strings. Turning a timestamptz into a JS
    // Date and back is how a payment posted at 11pm on the 30th becomes a
    // payment posted on the 1st in another timezone, and a rent ledger cannot
    // afford that class of bug. Formatting happens once, in the client, in the
    // property's timezone.
    case OID.DATE:
    case OID.TIME:
    case OID.TIMESTAMP:
    case OID.TIMESTAMPTZ:
      return raw;

    default:
      if (INT_ARRAY_OIDS.has(oid)) return parseArray(raw).map((v) => (v === null ? null : decodeBigInt(v)));
      if (TEXT_ARRAY_OIDS.has(oid)) return parseArray(raw);
      if (oid === OID.BOOL_ARRAY) return parseArray(raw).map((v) => (v === null ? null : v === "t"));
      return raw;
  }
}

/**
 * `bigint` columns hold money in cents. JavaScript numbers are exact up to
 * 2^53, which is about ninety trillion dollars — comfortably beyond any rent
 * ledger — but the guard stays, because "comfortably beyond" is the assumption
 * that eventually meets a test fixture with a deliberately absurd number in it.
 */
function decodeBigInt(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `refusing to decode ${raw}: outside the range JavaScript represents exactly`,
    );
  }
  return value;
}

/** PostgreSQL array literal: {a,b,"c,d",NULL} */
function parseArray(raw: string): (string | null)[] {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return [];
  const inner = raw.slice(1, -1);
  if (inner === "") return [];

  const out: (string | null)[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of inner) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(current === "NULL" ? null : current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current === "NULL" ? null : current);
  return out;
}

/**
 * Encode a JavaScript value as a text-format bound parameter. Everything
 * user-supplied goes through here and is transmitted as a parameter, never
 * interpolated into SQL — which is what makes injection structurally impossible
 * rather than a thing we remember to prevent.
 */
export function encodeParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot bind non-finite number ${value}`);
      return String(value);
    case "bigint":
      return String(value);
    case "boolean":
      return value ? "t" : "f";
    default:
      break;
  }

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
  if (Array.isArray(value)) return encodeArray(value);
  return JSON.stringify(value);
}

function encodeArray(values: unknown[]): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    const encoded = encodeParam(v);
    if (encoded === null) return "NULL";
    return `"${encoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}
