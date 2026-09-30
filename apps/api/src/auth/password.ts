/**
 * Password hashing.
 *
 * A note on the choice, because the project proposal names Argon2id and this
 * implements scrypt.
 *
 * Argon2id is the better function and remains the target. It is not in Node's
 * standard library, and this build has no runtime dependencies by design — the
 * deployment target is a property manager's own VPS, and every dependency is a
 * supply-chain surface they inherit and must patch. scrypt is memory-hard, is in
 * the standard library, and is explicitly acceptable under OWASP's password
 * storage guidance at the parameters used below. It is a considered second
 * choice, not an oversight.
 *
 * The seam is real rather than notional: `Hasher` below is the whole interface,
 * hashes are self-describing and carry their algorithm and parameters, and
 * `verify` dispatches on what a stored hash actually says. Adding argon2 means
 * writing one more Hasher and registering it. Existing residents are re-hashed
 * transparently on their next successful login, so a migration needs no reset
 * email and no downtime.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// promisify() picks the three-argument overload; spell out the one with options.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export interface Hasher {
  readonly id: string;
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
  /** True when `encoded` was produced with weaker parameters than current. */
  needsRehash(encoded: string): boolean;
}

/**
 * OWASP's minimum for scrypt is N=2^17, r=8, p=1. This uses N=2^17 (131072),
 * which costs roughly 128 MiB of memory per hash — deliberate, since memory
 * cost is the property that makes GPU-parallel cracking expensive.
 */
const SCRYPT_PARAMS = {
  N: 1 << 17,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 32,
} as const;

// Node's default maxmem (32 MiB) is below what these parameters need; the
// formula is 128 * N * r, with headroom.
const MAX_MEM = 256 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r;

export const scryptHasher: Hasher = {
  id: "scrypt",

  async hash(password: string): Promise<string> {
    assertPasswordShape(password);
    const salt = randomBytes(SCRYPT_PARAMS.saltLength);
    const derived = (await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: MAX_MEM,
    })) as Buffer;

    // Self-describing, in the style of PHC strings: every parameter needed to
    // verify this hash travels with it, so changing the defaults never
    // invalidates existing passwords.
    return [
      "scrypt",
      `n=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`,
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  },

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parseScryptHash(encoded);
    if (!parsed) return false;

    let derived: Buffer;
    try {
      derived = (await scrypt(password, parsed.salt, parsed.hash.length, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: Math.max(MAX_MEM, 256 * parsed.N * parsed.r),
      })) as Buffer;
    } catch {
      return false;
    }

    // Constant-time: a comparison that returns early on the first differing
    // byte leaks how much of a guess was correct.
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  },

  needsRehash(encoded: string): boolean {
    const parsed = parseScryptHash(encoded);
    if (!parsed) return true;
    return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.p < SCRYPT_PARAMS.p;
  },
};

interface ParsedScrypt {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseScryptHash(encoded: string): ParsedScrypt | null {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;

  const params: Record<string, number> = {};
  for (const pair of parts[1].split(",")) {
    const [key, value] = pair.split("=");
    params[key] = Number(value);
  }
  if (!Number.isSafeInteger(params.n) || !Number.isSafeInteger(params.r) || !Number.isSafeInteger(params.p)) {
    return null;
  }
  // A hostile row in the users table could otherwise ask this process to
  // allocate an arbitrary amount of memory during a login attempt.
  if (params.n > 1 << 20 || params.r > 32 || params.p > 16) return null;

  try {
    return {
      N: params.n,
      r: params.r,
      p: params.p,
      salt: Buffer.from(parts[2], "base64"),
      hash: Buffer.from(parts[3], "base64"),
    };
  } catch {
    return null;
  }
}

const HASHERS: Record<string, Hasher> = {
  scrypt: scryptHasher,
};

/** The hasher new passwords are written with. */
export const currentHasher: Hasher = scryptHasher;

export function registerHasher(hasher: Hasher): void {
  HASHERS[hasher.id] = hasher;
}

export async function hashPassword(password: string): Promise<{ hash: string; algorithm: string }> {
  return { hash: await currentHasher.hash(password), algorithm: currentHasher.id };
}

/**
 * Verify against whichever algorithm produced the stored hash, and report
 * whether it should be upgraded.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  const algorithm = encoded.split("$")[0];
  const hasher = HASHERS[algorithm];
  if (!hasher) return { valid: false, needsRehash: false };

  const valid = await hasher.verify(password, encoded);
  return {
    valid,
    needsRehash: valid && (hasher.id !== currentHasher.id || hasher.needsRehash(encoded)),
  };
}

/**
 * Burn comparable time on a login for an address that does not exist.
 *
 * Without this, "no such user" returns in a millisecond and "wrong password"
 * returns in a hundred, which turns the login form into an account-enumeration
 * oracle. For a rental portal that would disclose who lives in a building.
 *
 * The reference hash is built on first use and then reused. Building it lazily
 * rather than at module load keeps a 128 MiB scrypt off the import path — which
 * matters for the CLI commands that import this module and never authenticate
 * anyone — and guarantees it always reflects the current parameters.
 */
let dummyHash: Promise<string> | null = null;

export async function dummyVerify(): Promise<void> {
  dummyHash ??= currentHasher.hash(randomBytes(24).toString("hex"));
  await currentHasher.verify("not-the-password", await dummyHash);
}

const MIN_LENGTH = 12;
const MAX_LENGTH = 512;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

/**
 * Length, and a small blocklist. No composition rules: requiring a symbol and a
 * digit reliably produces "Password1!" and reliably discourages length, which is
 * the property that actually resists cracking. NIST SP 800-63B has recommended
 * against composition rules since 2017.
 */
export function assertPasswordShape(password: string): void {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    throw new WeakPasswordError(`Choose a password of at least ${MIN_LENGTH} characters.`);
  }
  if (password.length > MAX_LENGTH) {
    // An unbounded password is a denial-of-service vector against a memory-hard
    // KDF, which is the one place where "accept anything" is not generous.
    throw new WeakPasswordError(`Passwords must be ${MAX_LENGTH} characters or fewer.`);
  }
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(normalized)) {
    throw new WeakPasswordError("That password appears on published breach lists. Please choose another.");
  }
}

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "123456", "12345678", "123456789",
  "1234567890", "qwerty", "qwerty123", "letmein", "welcome", "welcome1", "admin", "admin123",
  "iloveyou", "monkey", "dragon", "sunshine", "princess", "football", "baseball", "abc123",
  "changeme", "trustno1", "master", "shadow", "superman", "michael", "jennifer",
  "residentportal", "rentportal", "apartment", "landlord", "tenant123", "myrent",
]);
