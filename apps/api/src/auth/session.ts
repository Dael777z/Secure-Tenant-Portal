/**
 * Sessions.
 *
 * A session token is a random 32-byte secret plus an HMAC over it. The database
 * stores only a SHA-256 of the token, never the token, so a disclosure of the
 * sessions table hands an attacker a set of hashes rather than a set of live
 * logins.
 *
 * Sessions rotate: past a configured age, a request is answered with a fresh
 * token and the old row is marked superseded. A stolen token therefore has a
 * bounded useful life even if the theft is never noticed, and a token that is
 * presented after its successor exists is evidence of theft rather than an
 * ordinary event — which is why that case revokes the whole chain.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "../db/pool.ts";
import { withoutContext } from "../db/context.ts";
import type { Role } from "../../../../packages/shared/src/roles.ts";

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  issuedAt: string;
  expiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  organizationId: string;
  organizationName: string;
  tenancyId: string | null;
  unitLabel: string | null;
  propertyName: string | null;
  mustChangePassword: boolean;
}

export interface SessionOptions {
  secret: string;
  ttlSeconds: number;
  rotateAfterSeconds: number;
}

/**
 * Token format: `<base64url selector>.<base64url hmac>`.
 *
 * The HMAC lets the server reject a forged or corrupted token without a
 * database round trip, which keeps an unauthenticated flood from becoming
 * database load. It is not the security boundary — the stored hash is.
 */
export function mintToken(secret: string): { token: string; hash: string } {
  const selector = randomBytes(32).toString("base64url");
  const signature = createHmac("sha256", secret).update(selector).digest("base64url");
  const token = `${selector}.${signature}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

export function verifyTokenSignature(token: string, secret: string): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const selector = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(selector).digest("base64url");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SessionStore {
  private readonly pool: Pool;
  private readonly options: SessionOptions;

  constructor(pool: Pool, options: SessionOptions) {
    this.pool = pool;
    this.options = options;
  }

  async create(
    userId: string,
    meta: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<{ token: string; session: SessionRecord }> {
    const { token, hash } = mintToken(this.options.secret);
    const csrfToken = randomBytes(24).toString("base64url");

    const row = await withoutContext(this.pool, (tx) =>
      tx.one<{ id: string; issued_at: string; expires_at: string }>(
        `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, $6)
         RETURNING id, issued_at, expires_at`,
        [userId, hash, csrfToken, String(this.options.ttlSeconds), meta.userAgent ?? null, meta.ipAddress ?? null],
      ),
    );

    return {
      token,
      session: {
        id: row.id,
        userId,
        csrfToken,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      },
    };
  }

  /**
   * Resolve a token to a user, or null. Also reports whether the caller should
   * be issued a fresh token, which the HTTP layer acts on by setting a new
   * cookie on the response.
   */
  async resolve(token: string): Promise<{
    user: AuthenticatedUser;
    session: SessionRecord;
    shouldRotate: boolean;
  } | null> {
    // Reject a malformed or unsigned token before touching the database.
    if (!verifyTokenSignature(token, this.options.secret)) return null;

    const hash = hashToken(token);

    const row = await withoutContext(this.pool, (tx) =>
      tx.maybeOne<{
        session_id: string;
        user_id: string;
        csrf_token: string;
        issued_at: string;
        expires_at: string;
        revoked_at: string | null;
        superseded_by: string | null;
        email: string;
        display_name: string;
        role: Role;
        active: boolean;
        must_change_password: boolean;
        organization_id: string;
        organization_name: string;
        tenancy_id: string | null;
        unit_label: string | null;
        property_name: string | null;
      }>(
        `SELECT
           s.id AS session_id, s.user_id, s.csrf_token, s.issued_at, s.expires_at, s.revoked_at,
           (SELECT r.id FROM sessions r WHERE r.rotated_from = s.id LIMIT 1) AS superseded_by,
           u.email, u.display_name, u.role, u.active, u.must_change_password,
           u.organization_id, o.name AS organization_name,
           t.id AS tenancy_id, un.label AS unit_label, p.name AS property_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN organizations o ON o.id = u.organization_id
         -- The resident's current lease: one they hold, or one they are an
         -- additional resident on (016). The lease they hold wins if both.
         LEFT JOIN LATERAL (
           SELECT t.* FROM tenancies t
           WHERE u.role = 'tenant' AND t.status = 'active'
             AND (t.resident_user_id = u.id OR EXISTS (
               SELECT 1 FROM tenancy_residents r
               WHERE r.tenancy_id = t.id AND r.user_id = u.id AND r.removed_at IS NULL))
           ORDER BY (t.resident_user_id = u.id) DESC, t.starts_on DESC
           LIMIT 1
         ) t ON true
         LEFT JOIN units un ON un.id = t.unit_id
         LEFT JOIN properties p ON p.id = t.property_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()`,
        [hash],
      ),
    );

    if (!row || !row.active) return null;

    // A token presented after its replacement exists means two parties hold it.
    // The safe reading is theft, so the whole chain is revoked and both are
    // logged out rather than the request being quietly served.
    if (row.superseded_by) {
      await this.revokeChain(row.session_id);
      return null;
    }

    const ageSeconds = (Date.now() - Date.parse(row.issued_at)) / 1000;

    return {
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        tenancyId: row.tenancy_id,
        unitLabel: row.unit_label,
        propertyName: row.property_name,
        mustChangePassword: row.must_change_password,
      },
      session: {
        id: row.session_id,
        userId: row.user_id,
        csrfToken: row.csrf_token,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      },
      shouldRotate: ageSeconds > this.options.rotateAfterSeconds,
    };
  }

  /** Issue a successor token and retire the predecessor. */
  async rotate(
    previous: SessionRecord,
    meta: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<{ token: string; session: SessionRecord }> {
    const { token, hash } = mintToken(this.options.secret);
    const csrfToken = randomBytes(24).toString("base64url");

    const row = await withoutContext(this.pool, async (tx) => {
      const created = await tx.one<{ id: string; issued_at: string; expires_at: string }>(
        `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, rotated_from, user_agent, ip_address)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, $6, $7)
         RETURNING id, issued_at, expires_at`,
        [
          previous.userId, hash, csrfToken, String(this.options.ttlSeconds),
          previous.id, meta.userAgent ?? null, meta.ipAddress ?? null,
        ],
      );
      // A short overlap, so that a request already in flight with the old token
      // is not rejected mid-payment.
      await tx.query(
        `UPDATE sessions SET revoked_at = now() + interval '30 seconds' WHERE id = $1`,
        [previous.id],
      );
      return created;
    });

    return {
      token,
      session: {
        id: row.id,
        userId: previous.userId,
        csrfToken,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      },
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await withoutContext(this.pool, (tx) =>
      tx.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]),
    );
  }

  /** Revoke a session and everything descended from it. */
  async revokeChain(sessionId: string): Promise<void> {
    await withoutContext(this.pool, (tx) =>
      tx.query(
        `WITH RECURSIVE chain AS (
           SELECT id FROM sessions WHERE id = $1
           UNION
           SELECT s.id FROM sessions s JOIN chain c ON s.rotated_from = c.id
         )
         UPDATE sessions SET revoked_at = now()
         WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL`,
        [sessionId],
      ),
    );
  }

  /** Used when a password changes: every other session for that user ends. */
  async revokeAllForUser(userId: string, except?: string): Promise<void> {
    await withoutContext(this.pool, (tx) =>
      tx.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [userId, except ?? null],
      ),
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await withoutContext(this.pool, (tx) =>
      tx.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'"),
    );
    return result.rowCount;
  }
}
