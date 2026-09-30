/**
 * Self-service password reset (migration 020).
 *
 * A person who forgot their password asks for a link by email and sets a new
 * one. Three properties matter more than the convenience:
 *
 *   1. The form never says whether an address has an account. For a rental
 *      portal, "does this email have an account" is "does this person live
 *      here". The route answers the same thing, in about the same time, either way.
 *   2. Only a hash of the link's token is stored. Someone who can read the
 *      database (a backup, an administrator) cannot use a pending link, and the
 *      link is never written to the notification queue, which is stored in clear.
 *   3. A link works once, for 30 minutes, and dies when a newer one is sent or
 *      the password changes any other way (the trigger in 020).
 *
 * All of this runs in the system context, like sign-in: nobody is signed in yet.
 */

import { createHash, randomBytes } from "node:crypto";
import { withoutContext } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import { hashPassword } from "../auth/password.ts";

export const RESET_LINK_MINUTES = 30;
/** Links one address can be sent in an hour. More are quietly not sent. */
export const RESET_LINKS_PER_HOUR = 3;

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export interface ResetRequest {
  /** Set only when a link should be emailed. */
  send: { userId: string; email: string; firstName: string; token: string } | null;
}

/**
 * Create a link for this address, if it belongs to an active account and has
 * not had too many links this hour. The caller must answer the person the same
 * way whether or not `send` is set.
 */
export async function requestReset(pool: Pool, email: string, ip: string | null): Promise<ResetRequest> {
  return withoutContext(pool, async (tx) => {
    const user = await tx.maybeOne<{ id: string; organization_id: string; email: string; display_name: string; recent: number }>(
      `SELECT u.id, u.organization_id, u.email, u.display_name,
              (SELECT count(*)::int FROM password_reset_tokens r
                WHERE r.user_id = u.id AND r.created_at > now() - interval '1 hour') AS recent
       FROM users u
       WHERE u.email = lower($1) AND u.active`,
      [email.trim()],
    );
    if (!user || user.recent >= RESET_LINKS_PER_HOUR) return { send: null };

    // A newer link replaces any older one still waiting.
    await tx.query(
      "UPDATE password_reset_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
      [user.id],
    );

    const token = randomBytes(32).toString("base64url");
    await tx.query(
      `INSERT INTO password_reset_tokens (organization_id, user_id, token_hash, requested_ip, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [user.organization_id, user.id, hashToken(token), ip, RESET_LINK_MINUTES],
    );
    await tx.query(
      `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, ip_address)
       SELECT u.organization_id, u.id, u.role, 'auth.password_reset_requested', 'user', u.id, $2
       FROM users u WHERE u.id = $1`,
      [user.id, ip],
    );

    return {
      send: {
        userId: user.id,
        email: user.email,
        firstName: user.display_name.split(" ")[0] || user.display_name,
        token,
      },
    };
  });
}

/** Whether a link can still be used, without using it. */
export async function checkResetToken(pool: Pool, token: string): Promise<boolean> {
  if (!token) return false;
  return withoutContext(pool, async (tx) => {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT r.id FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL
         AND r.expires_at > now() AND u.active`,
      [hashToken(token)],
    );
    return row !== null;
  });
}

export class ResetLinkInvalidError extends Error {
  constructor() {
    super("This link has expired or has already been used. Ask for a new one below.");
    this.name = "ResetLinkInvalidError";
  }
}

/**
 * Use a link: set the new password and return whose it was. Throws
 * ResetLinkInvalidError for an unknown, used, withdrawn or expired link, and
 * WeakPasswordError (from hashPassword) for a password that is not acceptable,
 * in which case the link stays usable.
 */
export async function completeReset(pool: Pool, token: string, newPassword: string, ip: string | null): Promise<string> {
  // Hash first: a weak password should not use up the link.
  const hashed = await hashPassword(newPassword);

  return withoutContext(pool, async (tx) => {
    // FOR UPDATE: two tabs submitting the same link at once cannot both succeed.
    const row = await tx.maybeOne<{ id: string; user_id: string }>(
      `SELECT r.id, r.user_id FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL
         AND r.expires_at > now() AND u.active
       FOR UPDATE OF r`,
      [hashToken(token)],
    );
    if (!row) throw new ResetLinkInvalidError();

    // Mark this link used before the password changes, so the trigger that
    // withdraws waiting links leaves this one recorded as used, not withdrawn.
    await tx.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
    await tx.query(
      `UPDATE users SET password_hash = $2, password_algorithm = $3, must_change_password = false,
                        failed_login_count = 0, locked_until = NULL
       WHERE id = $1`,
      [row.user_id, hashed.hash, hashed.algorithm],
    );
    await tx.query(
      `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, ip_address)
       SELECT u.organization_id, u.id, u.role, 'auth.password_reset', 'user', u.id, $2
       FROM users u WHERE u.id = $1`,
      [row.user_id, ip],
    );
    return row.user_id;
  });
}

export function resetEmail(options: { firstName: string; link: string }): { subject: string; body: string } {
  return {
    subject: "Reset your Summit password",
    body: [
      `Hi ${options.firstName},`,
      ``,
      `Someone asked to reset the password for your Summit account. If it was you, open this link to choose a new one:`,
      ``,
      options.link,
      ``,
      `The link works once, for ${RESET_LINK_MINUTES} minutes.`,
      ``,
      `If you did not ask for this, you can ignore this email. Your password has not changed, and no one can change it without this link.`,
    ].join("\n"),
  };
}
