/**
 * Serving the client.
 *
 * The API serves the browser client from the same origin. That is not laziness
 * — it means the Content-Security-Policy in server.ts can forbid every external
 * origin outright, there is no CORS surface, and the session cookie can be
 * SameSite=Strict. A separate static host would buy nothing here and cost all
 * three.
 *
 * TypeScript sources are type-stripped on the way out, so the client is written
 * in the same language as the API and imports the same shared type definitions —
 * which is what makes it impossible for the two to disagree about the shape of a
 * money field. In production the stripped output is cached in memory; there is
 * no build step to forget to run.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import type { Router } from "../http/router.ts";
import { PUBLIC } from "../http/router.ts";
import { notFound } from "../http/errors.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export function registerStaticRoutes(
  router: Router,
  deps: { webRoot: string; sharedRoot: string; production: boolean },
): void {
  const cache = new Map<string, { body: Buffer; contentType: string; etag: string }>();

  async function load(root: string, relative: string) {
    const key = `${root}::${relative}`;
    if (deps.production && cache.has(key)) return cache.get(key)!;

    const target = path.resolve(root, relative);
    // Path traversal: the request supplies this string, and "../../etc/passwd"
    // is the first thing anyone tries.
    if (target !== root && !target.startsWith(root + path.sep)) throw notFound();

    let info;
    try {
      info = await stat(target);
    } catch {
      throw notFound();
    }
    if (!info.isFile()) throw notFound();

    let body = await readFile(target);
    const extension = path.extname(target);

    // Strip types on the way out, so the browser receives valid JavaScript and
    // the repository contains TypeScript.
    if (extension === ".ts") {
      const source = body.toString("utf8");
      const stripped = stripTypeScriptTypes(source, { mode: "strip" });
      // Rewrite .ts specifiers to .js so the browser's module resolver, which
      // knows nothing about TypeScript, follows the same import graph.
      body = Buffer.from(stripped.replace(/(from\s+["'])([^"']+)\.ts(["'])/g, "$1$2.js$3"), "utf8");
    }

    const entry = {
      body,
      contentType: CONTENT_TYPES[extension === ".ts" ? ".js" : extension] ?? "application/octet-stream",
      etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
    };

    if (deps.production) cache.set(key, entry);
    return entry;
  }

  const serve = (root: string) => async (ctx: import("../http/context.ts").HttpContext) => {
    const requested = ctx.params["*"] || "index.html";
    // Requests arrive for .js because that is what the browser asks for after
    // the specifier rewrite above; the file on disk is .ts.
    const candidates = requested.endsWith(".js")
      ? [requested.replace(/\.js$/, ".ts"), requested]
      : [requested];

    let entry;
    for (const candidate of candidates) {
      try {
        entry = await load(root, candidate);
        break;
      } catch {
        continue;
      }
    }
    if (!entry) throw notFound();

    if (ctx.req.headers["if-none-match"] === entry.etag) {
      ctx.res.writeHead(304, { etag: entry.etag });
      ctx.res.end();
      return;
    }

    ctx.buffer(200, entry.body, entry.contentType, {
      etag: entry.etag,
      "cache-control": deps.production ? "public, max-age=300, must-revalidate" : "no-store",
    });
  };

  router.get("/shared/*", PUBLIC, serve(path.resolve(deps.sharedRoot)));
  router.get("/app/*", PUBLIC, serve(path.resolve(deps.webRoot)));

  // Client-side routing: any path that is not an API call and not a file gets
  // the shell, which then reads the URL and renders the right view.
  const shell = async (ctx: import("../http/context.ts").HttpContext) => {
    const entry = await load(path.resolve(deps.webRoot), "index.html");
    ctx.buffer(200, entry.body, entry.contentType, { "cache-control": "no-store" });
  };

  router.get("/", PUBLIC, shell);
  router.get("/*", PUBLIC, async (ctx) => {
    if (ctx.path.startsWith("/api/")) throw notFound();
    return shell(ctx);
  });
}
