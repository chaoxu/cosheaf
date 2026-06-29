import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { AUTH_COOKIE, bearerToken, isLocalMode } from "./middleware.js";
import type { AppEnv } from "./types.js";
import { rejectCrossOriginMutation } from "./routes/web-context.js";

export const rejectCrossOriginCookieApiMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  // Local Workbench: authority is ambient (no token), so any cross-origin page
  // that knows the loopback port could otherwise drive file writes and git
  // commit/push. Enforce the same-origin check on every mutation, like a cookie
  // session.
  if (isLocalMode(c)) {
    const crossOrigin = rejectCrossOriginMutation(c);
    if (crossOrigin) return crossOrigin;
    return next();
  }
  if (bearerToken(c.req.header("authorization"))) return next();
  if (!getCookie(c, AUTH_COOKIE)) return next();
  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return crossOrigin;
  await next();
};
