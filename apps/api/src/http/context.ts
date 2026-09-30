/**
 * The per-request object handed to every route handler.
 *
 * It carries the parsed request, the authenticated identity if there is one, and
 * the response helpers. Nothing here reaches the database: a handler that wants
 * data asks for a transaction with an explicit security context, which is what
 * makes "which identity is this query running as" a question with a visible
 * answer at every call site.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthenticatedUser, SessionRecord } from "../auth/session.ts";
import type { RequestContext } from "../db/context.ts";

export interface HttpContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  readonly requestId: string;
  readonly ip: string;
  readonly startedAt: number;

  body: unknown;

  user: AuthenticatedUser | null;
  session: SessionRecord | null;

  /** The identity a database transaction opened from this request will carry. */
  dbContext(): RequestContext;

  json(status: number, payload: unknown): void;
  text(status: number, body: string, contentType?: string): void;
  buffer(status: number, body: Buffer, contentType: string, headers?: Record<string, string>): void;
  noContent(): void;
  setHeader(name: string, value: string): void;
  setCookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string): void;
  cookies(): Record<string, string>;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  // HttpOnly is the default rather than an option a caller might forget: a
  // session cookie readable from JavaScript is one XSS away from being a
  // stolen session.
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}
