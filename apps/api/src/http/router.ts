/**
 * A small router and the middleware chain.
 *
 * Routes are declared with their required capability, not merely their path, so
 * that "who may call this" is visible at the point of declaration rather than
 * buried in the handler. A route with no declared access rule does not default
 * to public — it fails to register.
 */

import type { HttpContext } from "./context.ts";
import { forbidden, notFound, unauthorized } from "./errors.ts";
import { can, type Capability, type Role } from "../../../../packages/shared/src/roles.ts";

export type Handler = (ctx: HttpContext) => Promise<unknown> | unknown;
export type Middleware = (ctx: HttpContext, next: () => Promise<void>) => Promise<void>;

export type Access =
  /** No session required. Login, health, static assets, provider webhooks. */
  | { kind: "public" }
  /** Any authenticated session. */
  | { kind: "authenticated" }
  /** An authenticated session holding a specific capability. */
  | { kind: "capability"; capability: Capability }
  /** An authenticated session in one of these roles. */
  | { kind: "roles"; roles: readonly Role[] };

export const PUBLIC: Access = { kind: "public" };
export const AUTHENTICATED: Access = { kind: "authenticated" };
export const requires = (capability: Capability): Access => ({ kind: "capability", capability });
export const roles = (...list: Role[]): Access => ({ kind: "roles", roles: list });

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
  access: Access;
  /** Mutating routes are checked for a matching CSRF token. */
  mutating: boolean;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly middleware: Middleware[] = [];

  use(middleware: Middleware): this {
    this.middleware.push(middleware);
    return this;
  }

  get(pattern: string, access: Access, handler: Handler): this {
    return this.add("GET", pattern, access, handler);
  }
  post(pattern: string, access: Access, handler: Handler): this {
    return this.add("POST", pattern, access, handler);
  }
  put(pattern: string, access: Access, handler: Handler): this {
    return this.add("PUT", pattern, access, handler);
  }
  patch(pattern: string, access: Access, handler: Handler): this {
    return this.add("PATCH", pattern, access, handler);
  }
  delete(pattern: string, access: Access, handler: Handler): this {
    return this.add("DELETE", pattern, access, handler);
  }

  private add(method: string, pattern: string, access: Access, handler: Handler): this {
    this.routes.push({
      method,
      pattern,
      segments: pattern.split("/").filter(Boolean),
      handler,
      access,
      mutating: method !== "GET" && method !== "HEAD",
    });
    return this;
  }

  /** Every registered route with its access rule — the input to the route audit. */
  describe(): Array<{ method: string; pattern: string; access: string }> {
    return this.routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
      access:
        route.access.kind === "capability"
          ? `capability:${route.access.capability}`
          : route.access.kind === "roles"
            ? `roles:${route.access.roles.join("|")}`
            : route.access.kind,
    }));
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;

      // A trailing "*" matches the remainder, used only for static assets.
      const wildcard = route.segments[route.segments.length - 1] === "*";
      if (!wildcard && route.segments.length !== parts.length) continue;
      if (wildcard && parts.length < route.segments.length - 1) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment === "*") {
          params["*"] = parts.slice(i).join("/");
          break;
        }
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }

    return null;
  }

  async handle(ctx: HttpContext, resolve: (ctx: HttpContext) => Promise<void>): Promise<void> {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() called more than once in a middleware");
      index = i;
      const middleware = this.middleware[i];
      if (!middleware) return resolve(ctx);
      await middleware(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
  }
}

/**
 * Enforce a route's declared access rule.
 *
 * This is the application's own check. It is a convenience and a clear error
 * message — the guarantee that a resident cannot read another resident's rows
 * lives in the database, not here, precisely so that a mistake in this function
 * is a bug rather than a breach.
 */
export function enforceAccess(access: Access, ctx: HttpContext): void {
  if (access.kind === "public") return;

  if (!ctx.user) throw unauthorized();

  if (access.kind === "authenticated") return;

  if (access.kind === "roles") {
    if (!access.roles.includes(ctx.user.role)) throw notFound();
    return;
  }

  if (!can(ctx.user.role, access.capability)) {
    // 404 rather than 403 where the path itself would confirm that a resource
    // exists for someone. A resident probing manager routes learns nothing.
    throw notFound();
  }
}

export { notFound as routeNotFound, forbidden as routeForbidden };
