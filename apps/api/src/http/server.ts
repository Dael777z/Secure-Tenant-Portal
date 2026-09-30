/**
 * The HTTP server: request parsing, security headers, rate limiting, CSRF,
 * session resolution, and error rendering.
 *
 * Built on node:http rather than a framework, for the same reason the database
 * client is: this process handles rent payments on hardware a property manager
 * patches themselves, and the middleware stack is small enough to read in one
 * sitting.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { Config } from "../config.ts";
import { HttpError, badRequest, payloadTooLarge, serverError, tooManyRequests, unauthorized } from "./errors.ts";
import { type CookieOptions, type HttpContext, parseCookies, serializeCookie } from "./context.ts";
import { enforceAccess, Router } from "./router.ts";
import type { SessionStore } from "../auth/session.ts";
import type { RequestContext } from "../db/context.ts";
import { describeDatabaseRefusal, NotFoundError } from "../db/context.ts";
import { ValidationError } from "../../../../packages/shared/src/validate.ts";
import { CSRF_HEADER, REQUEST_ID_HEADER } from "../../../../packages/shared/src/api.ts";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB. Photo uploads have their own path.

export interface ServerDeps {
  config: Config;
  router: Router;
  sessions: SessionStore;
  log: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

export function createServer(deps: ServerDeps): http.Server {
  const { config, router, sessions, log } = deps;
  const limiter = new RateLimiter(config.security.rateLimitPerMinute);

  return http.createServer((req, res) => {
    void handleRequest(req, res, deps, limiter).catch((error) => {
      log("error", "unhandled error escaped the request pipeline", {
        error: (error as Error).message,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "server_error", message: "Something went wrong." } }));
      }
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  limiter: RateLimiter,
): Promise<void> {
  const { config, router, sessions, log } = deps;
  const startedAt = Date.now();
  const requestId = randomUUID();

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const ip = clientIp(req, config.security.trustProxy);
  const ctx = makeContext(req, res, url.pathname, query, requestId, ip);

  applySecurityHeaders(res, config);
  res.setHeader(REQUEST_ID_HEADER, requestId);

  try {
    // Rate limiting first: a flood should cost a map lookup, not a database
    // round trip and a password hash.
    //
    // Scoped to the API. A browser opening the app fetches thirty-odd ES
    // modules and stylesheets in a burst; counting those against the same
    // budget as payment submissions would throttle an ordinary page load while
    // doing nothing about the traffic worth limiting. Static assets touch no
    // database and no session.
    if (url.pathname.startsWith("/api/")) {
      const verdict = limiter.check(ip);
      if (!verdict.allowed) {
        throw tooManyRequests(
          "Too many requests from this address. Please wait a moment and try again.",
          verdict.retryAfterSeconds,
        );
      }
    }

    const match = router.match(req.method ?? "GET", url.pathname);
    if (!match) {
      ctx.json(404, { error: { code: "not_found", message: "No such endpoint.", requestId } });
      return;
    }

    // Session resolution happens for every request, including public ones, so
    // that a login page knows whether to redirect an already-authenticated user.
    const token = ctx.cookies()[config.session.cookieName];
    if (token) {
      const resolved = await sessions.resolve(token);
      if (resolved) {
        ctx.user = resolved.user;
        ctx.session = resolved.session;

        if (resolved.shouldRotate) {
          const rotated = await sessions.rotate(resolved.session, {
            userAgent: req.headers["user-agent"],
            ipAddress: ip,
          });
          ctx.session = rotated.session;
          setSessionCookie(ctx, config, rotated.token);
        }
      }
    }

    Object.assign(ctx.params, match.params);

    if (match.route.mutating) {
      // Body first: CSRF checking needs nothing from it, but a 413 should be
      // reported before an authorization failure so the caller learns the real
      // problem.
      ctx.body = await readJsonBody(req);
      assertCsrf(ctx, config);
    }

    enforceAccess(match.route.access, ctx);

    // A resident with an expired temporary password may do exactly one thing.
    if (
      ctx.user?.mustChangePassword &&
      !url.pathname.startsWith("/api/v1/auth/") &&
      url.pathname !== "/api/v1/health"
    ) {
      throw new HttpError(
        403,
        "password_change_required",
        "Please choose a new password before continuing.",
      );
    }

    const result = await match.route.handler(ctx);
    if (!res.writableEnded) {
      if (result === undefined || result === null) ctx.noContent();
      else ctx.json(200, result);
    }
  } catch (error) {
    renderError(ctx, error, deps);
  } finally {
    const duration = Date.now() - startedAt;
    log("info", `${req.method} ${url.pathname}`, {
      status: res.statusCode,
      ms: duration,
      requestId,
      userId: ctx.user?.id,
      role: ctx.user?.role,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Context construction
 * ------------------------------------------------------------------ */

function makeContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  query: Record<string, string>,
  requestId: string,
  ip: string,
): HttpContext {
  let cookieCache: Record<string, string> | null = null;

  const ctx: HttpContext = {
    req,
    res,
    method: req.method ?? "GET",
    path,
    query,
    params: {},
    requestId,
    ip,
    startedAt: Date.now(),
    body: undefined,
    user: null,
    session: null,

    dbContext(): RequestContext {
      if (!ctx.user) return { userId: null, role: "tenant", organizationId: null };
      return {
        userId: ctx.user.id,
        role: ctx.user.role,
        organizationId: ctx.user.organizationId,
      };
    },

    json(status, payload) {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    },

    text(status, body, contentType = "text/plain; charset=utf-8") {
      res.writeHead(status, {
        "content-type": contentType,
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    },

    buffer(status, body, contentType, headers = {}) {
      res.writeHead(status, { ...headers, "content-type": contentType, "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    },

    noContent() {
      res.writeHead(204);
      res.end();
    },

    setHeader(name, value) {
      res.setHeader(name, value);
    },

    setCookie(name, value, options: CookieOptions) {
      const existing = res.getHeader("set-cookie");
      const cookie = serializeCookie(name, value, options);
      const all = Array.isArray(existing) ? [...existing, cookie] : existing ? [String(existing), cookie] : [cookie];
      res.setHeader("set-cookie", all);
    },

    clearCookie(name) {
      ctx.setCookie(name, "", { maxAgeSeconds: 0 });
    },

    cookies() {
      cookieCache ??= parseCookies(req.headers.cookie);
      return cookieCache;
    },
  };

  return ctx;
}

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

function applySecurityHeaders(res: http.ServerResponse, config: Config): void {
  // No inline script and no external origins. The client is served as plain ES
  // modules from this same origin, so it needs neither, and saying so here is
  // what makes a stored-XSS bug in, say, a maintenance description inert.
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; "),
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("permissions-policy", "geolocation=(), camera=(), microphone=(), payment=()");
  if (config.session.secureCookies) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

export function setSessionCookie(ctx: HttpContext, config: Config, token: string): void {
  ctx.setCookie(config.session.cookieName, token, {
    maxAgeSeconds: config.session.ttlSeconds,
    httpOnly: true,
    secure: config.session.secureCookies,
    // Strict rather than Lax: there is no legitimate cross-site navigation into
    // an authenticated action here, and Strict removes a class of CSRF outright
    // rather than relying only on the token check below.
    sameSite: "Strict",
    path: "/",
  });
}

/* ------------------------------------------------------------------ *
 * CSRF
 * ------------------------------------------------------------------ */

function assertCsrf(ctx: HttpContext, config: Config): void {
  // Webhooks are authenticated by provider signature, not by a session, and
  // carry no cookie — a CSRF token is meaningless for them.
  if (ctx.path.startsWith("/api/v1/webhooks/")) return;
  // An unauthenticated POST (login) has no session to forge against.
  if (!ctx.session) return;

  const provided = ctx.req.headers[CSRF_HEADER];
  const expected = ctx.session.csrfToken;
  if (typeof provided !== "string" || provided.length !== expected.length) {
    throw new HttpError(403, "csrf_failed", "Your session could not be verified. Please reload and try again.");
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  let differences = 0;
  for (let i = 0; i < a.length; i += 1) differences |= a[i] ^ b[i];
  if (differences !== 0) {
    throw new HttpError(403, "csrf_failed", "Your session could not be verified. Please reload and try again.");
  }
}

/* ------------------------------------------------------------------ *
 * Body parsing
 * ------------------------------------------------------------------ */

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.startsWith("multipart/form-data")) return undefined; // handled by the upload route
  // A raw upload (a photo, a lease PDF) is streamed by its own route. Reading it
  // here consumed the stream and then failed it as "not valid JSON", so no
  // upload could ever succeed.
  if (contentType && !/json/i.test(contentType)) return undefined;

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw payloadTooLarge("That request is too large.");
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // Checked as bytes arrive, not only against the declared length, because a
    // hostile client can declare anything.
    if (total > MAX_BODY_BYTES) throw payloadTooLarge("That request is too large.");
    chunks.push(chunk as Buffer);
  }

  if (total === 0) return undefined;

  const raw = Buffer.concat(chunks, total).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("The request body was not valid JSON.");
  }
}

/* ------------------------------------------------------------------ *
 * Error rendering
 * ------------------------------------------------------------------ */

function renderError(ctx: HttpContext, error: unknown, deps: ServerDeps): void {
  if (ctx.res.writableEnded) return;

  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) ctx.setHeader(name, value);
    ctx.json(error.status, {
      error: { code: error.code, message: error.message, issues: error.issues, requestId: ctx.requestId },
    });
    return;
  }

  if (error instanceof ValidationError) {
    ctx.json(422, {
      error: {
        code: "validation_failed",
        message: "Some of the information sent was not valid.",
        issues: error.issues,
        requestId: ctx.requestId,
      },
    });
    return;
  }

  // A query that expected one row and found none is, far more often than not,
  // Row-Level Security correctly refusing access. Both render as 404.
  if (error instanceof NotFoundError) {
    ctx.json(404, {
      error: { code: "not_found", message: "We could not find that.", requestId: ctx.requestId },
    });
    return;
  }

  const refusal = describeDatabaseRefusal(error);
  if (refusal) {
    deps.log("warn", "database refused an operation", {
      requestId: ctx.requestId,
      path: ctx.path,
      userId: ctx.user?.id,
      detail: (error as Error).message,
    });
    ctx.json(403, { error: { code: "refused", message: refusal, requestId: ctx.requestId } });
    return;
  }

  deps.log("error", "unhandled error", {
    requestId: ctx.requestId,
    path: ctx.path,
    userId: ctx.user?.id,
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  // Never the underlying message: it can carry SQL, table names, or fragments
  // of another resident's data.
  const response = serverError();
  ctx.json(response.status, {
    error: { code: response.code, message: response.message, requestId: ctx.requestId },
  });
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/**
 * A fixed-window counter per address. Deliberately in-process: a single
 * self-hosted instance is the deployment model, and an external store would add
 * a dependency and a failure mode to buy precision this does not need.
 */
class RateLimiter {
  private readonly limit: number;
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number) {
    this.limit = limit;
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    if (this.limit <= 0) return { allowed: true, retryAfterSeconds: 0 };

    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    window.count += 1;
    if (window.count > this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      // Leftmost is the original client; the rest are proxies.
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

export { unauthorized };
