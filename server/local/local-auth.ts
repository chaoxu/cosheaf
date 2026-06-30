// The local Workbench's optional access gate.
//
// By default the Workbench is a loopback, single-user tool with no auth — opening
// any registered folder grants full local file authority. That is safe only
// because nothing off-box can reach 127.0.0.1. To let the operator run the
// Workbench on a dev box and reach it from another device, `COSHEAF_WORKBENCH_TOKEN`
// turns on a single shared access token: every request must present it (as
// `Authorization: Bearer <token>` for API/agents, or the `cosheaf_wb` HttpOnly
// cookie set by the /login page for browsers). This is the N=1 degenerate of the
// hosted server's multi-user token auth — one token, one identity.
//
// Exposing the Workbench beyond loopback and terminating TLS is the operator's
// job (tunnel, reverse proxy, VPN, …); this gate only makes that safe. The
// launcher refuses to bind a non-loopback host unless a token is configured.

import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { bearerToken } from "../middleware.js";
import type { AppEnv } from "../types.js";

export const WORKBENCH_COOKIE = "cosheaf_wb";

// Reachable without the token so a browser can authenticate and tools can probe
// liveness / capabilities. Static assets are served by app.ts ahead of both gate
// mount points, so they never reach the gate and need no entry here.
const EXEMPT_PATHS = new Set(["/login", "/logout", "/api/v1/health", "/api/v1/origin"]);

// Constant-time token comparison that tolerates unequal lengths (timingSafeEqual
// throws on a length mismatch). Returns false for a null/blank presented token.
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// True when the request carries the workbench access token, by Bearer header or
// the cosheaf_wb cookie.
export function hasWorkbenchAccess(c: Context<AppEnv>, expected: string): boolean {
  const presented = bearerToken(c.req.header("authorization")) ?? getCookie(c, WORKBENCH_COOKIE) ?? null;
  return tokenMatches(presented, expected);
}

// The gate middleware. With no configured token it is a pass-through (today's
// loopback no-auth behavior). With a token, unauthenticated requests get a 401
// (API paths) or a redirect to /login (browser pages); exempt paths always pass.
export function localAuthGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const expected = c.get("config").accessToken;
    if (!expected) return next();
    if (EXEMPT_PATHS.has(c.req.path)) return next();
    if (hasWorkbenchAccess(c, expected)) return next();
    // `code: "unauthorized"` so the editor/reader island's api.ts bounces to
    // /login when a remote session's cookie expires mid-edit (it keys the
    // redirect on the code, not the status alone).
    if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized", code: "unauthorized" }, 401);
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
  };
}
