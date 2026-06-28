// App-level error mapping. A ForgejoError (hosted forge call) or
// WorkspaceBackendError (the WorkspaceBackend seam — file/tree/branch routes)
// that escapes a route handler is translated into the surface the caller
// expects: the typed JSON envelope on /api/* and a styled error page on
// server-rendered web routes. Both carry `.status`, so they share one mapping.
// Everything else falls through to Hono's default 500.

import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { ForgejoError } from "../forgejo.js";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { AUTH_COOKIE, invalidateBearerCache } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { badGateway, forbidden, notFound } from "./responses.js";
import { errorPage, forbiddenPage, notFoundPage, redirect } from "./web-context.js";

export async function handleAppError(err: Error, c: Context<AppEnv>): Promise<Response> {
  const isApi = c.req.path.startsWith("/api/");
  if (!(err instanceof ForgejoError) && !(err instanceof WorkspaceBackendError)) throw err;

  // A 401 from the backing forge means the caller's token was rejected
  // (revoked, rotated). Invalidate the cache so the next request re-checks;
  // API callers get the typed `pat_invalid` signal, web sessions go back to
  // the login page.
  if (err.status === 401) {
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (bearer) invalidateBearerCache(bearer);
    const cookiePat = getCookie(c, AUTH_COOKIE);
    if (cookiePat) invalidateBearerCache(cookiePat);
    if (!isApi) return redirect("/login");
    return c.json(
      { error: "Backend rejected the credentials; please log in again.", code: "pat_invalid" },
      401,
    );
  }

  const user = c.get("user")?.username ?? "";
  const reqId = c.get("requestId") ?? "";
  if (isApi) {
    if (err.status === 404) return c.json(...notFound());
    if (err.status === 403) return c.json(...forbidden("backend denied the operation"));
    // The API 502 path used to return without a trace; log it so a caller's
    // bad_gateway can be correlated to the upstream failure by request id.
    console.error(`[${reqId}] backend request failed on ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json(...badGateway(`backend request failed (${err.status})`));
  }
  if (err.status === 404) return notFoundPage(user, "Not found");
  if (err.status === 403) return forbiddenPage(user);
  console.error(`[${reqId}] unhandled backend error on ${c.req.method} ${c.req.path}: ${err.message}`);
  return errorPage(user, "The backing forge failed to answer. Try again in a moment.", 502);
}
