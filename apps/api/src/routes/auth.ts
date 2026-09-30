/**
 * Authentication routes.
 *
 * The login handler is written around one property: it must take the same
 * amount of time and say the same thing whether the address exists or not.
 * Without that, the form is an account-enumeration oracle, and for a rental
 * portal what it enumerates is who lives in a building.
 */

import type { Router } from "../http/router.ts";
import type { HttpContext } from "../http/context.ts";
import { AUTHENTICATED, PUBLIC } from "../http/router.ts";
import { setSessionCookie } from "../http/server.ts";
import { badRequest, HttpError, tooManyRequests, unauthorized } from "../http/errors.ts";
import { withoutContext } from "../db/context.ts";
import type { Pool } from "../db/pool.ts";
import type { SessionStore } from "../auth/session.ts";
import { dummyVerify, hashPassword, verifyPassword, WeakPasswordError } from "../auth/password.ts";
import type { Config } from "../config.ts";
import * as api from "../../../../packages/shared/src/api.ts";
import type { Role } from "../../../../packages/shared/src/roles.ts";
import { CAPABILITIES_BY_ROLE, ROLE_DESCRIPTIONS, ROLE_LABELS } from "../../../../packages/shared/src/roles.ts";
import type { Transport } from "../providers/notify/index.ts";
import {
  checkResetToken,
  completeReset,
  requestReset,
  resetEmail,
  ResetLinkInvalidError,
  RESET_LINK_MINUTES,
} from "../domain/password-reset.ts";

export function registerAuthRoutes(
  router: Router,
  deps: {
    pool: Pool;
    sessions: SessionStore;
    config: Config;
    transport: Transport;
    log?: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
  },
): void {
  const { pool, sessions, config, transport } = deps;
  const log = deps.log ?? (() => {});

  /** Sign a person in: the session, the cookie, and the body the client expects. */
  async function startSession(ctx: HttpContext, userId: string) {
    const created = await sessions.create(userId, {
      userAgent: String(ctx.req.headers["user-agent"] ?? ""),
      ipAddress: ctx.ip,
    });
    setSessionCookie(ctx, config, created.token);
    const resolved = await sessions.resolve(created.token);
    if (!resolved) throw new HttpError(500, "session_failed", "Could not establish a session.");
    ctx.json(200, {
      user: resolved.user,
      csrfToken: created.session.csrfToken,
      expiresAt: created.session.expiresAt,
    });
  }

  router.post("/api/v1/auth/login", PUBLIC, async (ctx) => {
    const input = api.loginRequest.parse(ctx.body);

    const user = await withoutContext(pool, (tx) =>
      tx.maybeOne<{
        id: string;
        email: string;
        password_hash: string;
        role: Role;
        active: boolean;
        failed_login_count: number;
        locked_until: string | null;
      }>(
        `SELECT id, email, password_hash, role, active, failed_login_count, locked_until::text AS locked_until
         FROM users WHERE email = $1`,
        [input.email],
      ),
    );

    // No user: still pay the cost of a hash, then give the same answer as a
    // wrong password. The timing and the wording must not differ.
    if (!user) {
      await dummyVerify();
      throw unauthorized("That email address and password do not match.");
    }

    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      const seconds = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 1000);
      throw tooManyRequests(
        `Too many sign-in attempts. Please try again in ${Math.ceil(seconds / 60)} minutes.`,
        seconds,
      );
    }

    const { valid, needsRehash } = await verifyPassword(input.password, user.password_hash);

    if (!valid) {
      await withoutContext(pool, (tx) =>
        tx.query(
          `UPDATE users SET
             failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= $2
                                 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
           WHERE id = $1`,
          [user.id, config.security.maxFailedLogins, String(config.security.lockoutMinutes)],
        ),
      );
      throw unauthorized("That email address and password do not match.");
    }

    if (!user.active) {
      throw unauthorized("This account is no longer active. Please contact the office.");
    }

    await withoutContext(pool, async (tx) => {
      await tx.query(
        "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
        [user.id],
      );
      // Transparent parameter upgrade: no reset email, no downtime, no window
      // where old hashes linger because a migration was never run.
      if (needsRehash) {
        const upgraded = await hashPassword(input.password);
        await tx.query("UPDATE users SET password_hash = $2, password_algorithm = $3 WHERE id = $1", [
          user.id,
          upgraded.hash,
          upgraded.algorithm,
        ]);
      }
      await tx.query(
        `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, ip_address)
         SELECT u.organization_id, u.id, u.role, 'auth.login', 'user', u.id, $2
         FROM users u WHERE u.id = $1`,
        [user.id, ctx.ip],
      );
    });

    await startSession(ctx, user.id);
  });

  router.post("/api/v1/auth/logout", AUTHENTICATED, async (ctx) => {
    if (ctx.session) await sessions.revokeChain(ctx.session.id);
    ctx.clearCookie(config.session.cookieName);
    ctx.json(200, { ok: true });
  });

  router.get("/api/v1/auth/me", PUBLIC, (ctx) => {
    if (!ctx.user || !ctx.session) {
      ctx.json(200, { user: null, csrfToken: null });
      return;
    }
    ctx.json(200, {
      user: ctx.user,
      csrfToken: ctx.session.csrfToken,
      expiresAt: ctx.session.expiresAt,
      capabilities: CAPABILITIES_BY_ROLE[ctx.user.role],
      roleLabel: ROLE_LABELS[ctx.user.role],
      roleDescription: ROLE_DESCRIPTIONS[ctx.user.role],
    });
  });

  router.post("/api/v1/auth/change-password", AUTHENTICATED, async (ctx) => {
    const input = api.changePasswordRequest.parse(ctx.body);
    const userId = ctx.user!.id;

    const record = await withoutContext(pool, (tx) =>
      tx.one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]),
    );

    const { valid } = await verifyPassword(input.currentPassword, record.password_hash);
    if (!valid) throw unauthorized("Your current password is not correct.");

    if (input.currentPassword === input.newPassword) {
      throw badRequest("Your new password must be different from the current one.");
    }

    let hashed;
    try {
      hashed = await hashPassword(input.newPassword);
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      throw error;
    }

    await withoutContext(pool, async (tx) => {
      await tx.query(
        "UPDATE users SET password_hash = $2, password_algorithm = $3, must_change_password = false WHERE id = $1",
        [userId, hashed.hash, hashed.algorithm],
      );
      await tx.query(
        `INSERT INTO audit_log (organization_id, actor_user_id, actor_role, action, subject_type, subject_id, ip_address)
         SELECT u.organization_id, u.id, u.role, 'auth.password_changed', 'user', u.id, $2
         FROM users u WHERE u.id = $1`,
        [userId, ctx.ip],
      );
    });

    // Everything except the session doing the changing. If the reason for the
    // change is that somebody else had the old password, this is the step that
    // actually removes them.
    await sessions.revokeAllForUser(userId, ctx.session?.id);

    ctx.json(200, { ok: true, message: "Your password has been changed. Other sessions were signed out." });
  });

  /* ---------------------------------------------------------------- *
   * Forgot password (020)
   * ---------------------------------------------------------------- */

  // The same answer whether or not the address has an account, and the email
  // is sent after the response rather than before it, so the time taken does
  // not give the answer away either.
  router.post("/api/v1/auth/forgot-password", PUBLIC, async (ctx) => {
    const input = api.forgotPasswordRequest.parse(ctx.body);
    const request = await requestReset(pool, input.email, ctx.ip);
    ctx.json(200, {
      ok: true,
      message:
        `If an account uses ${input.email}, we have sent it a link to set a new password. ` +
        `The link works for ${RESET_LINK_MINUTES} minutes. Check your spam folder if it does not arrive.`,
    });
    if (request.send) {
      const { email, firstName, token } = request.send;
      // The token travels after "#", which browsers never send to a server, so
      // it stays out of access logs and Referer headers.
      const link = `${config.publicUrl.replace(/\/$/, "")}/reset-password#token=${token}`;
      const message = resetEmail({ firstName, link });
      void transport
        .send({ channel: "email", to: email, subject: message.subject, body: message.body })
        .catch((error: Error) => log("error", "password reset email failed", { error: error.message }));
    }
  });

  router.post("/api/v1/auth/reset-password/check", PUBLIC, async (ctx) => {
    const input = api.resetTokenRequest.parse(ctx.body);
    ctx.json(200, { valid: await checkResetToken(pool, input.token) });
  });

  router.post("/api/v1/auth/reset-password", PUBLIC, async (ctx) => {
    const input = api.resetPasswordRequest.parse(ctx.body);
    let userId: string;
    try {
      userId = await completeReset(pool, input.token, input.newPassword, ctx.ip);
    } catch (error) {
      if (error instanceof WeakPasswordError) throw badRequest(error.message);
      if (error instanceof ResetLinkInvalidError) throw badRequest(error.message);
      throw error;
    }
    // Whoever had the old password is signed out everywhere; the person who
    // just proved they own the email address is signed in.
    await sessions.revokeAllForUser(userId);
    await startSession(ctx, userId);
  });
}
