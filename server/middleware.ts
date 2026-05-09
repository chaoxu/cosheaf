import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";
import { userFromSession, userFromToken } from "./auth.js";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.get("db");
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const user = userFromToken(db, auth.slice("Bearer ".length).trim());
    if (user) {
      c.set("user", user);
      await next();
      return;
    }
  }
  const sessionId = getCookie(c, "session");
  if (!sessionId) return c.json({ error: "not authenticated", code: "unauthorized" }, 401);
  const user = userFromSession(db, sessionId);
  if (!user) return c.json({ error: "not authenticated", code: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

export const requireMembership = (param = "slug"): MiddlewareHandler<AppEnv> => async (c, next) => {
  const slug = c.req.param(param);
  if (!slug) return c.json({ error: "workspace required", code: "validation" }, 400);
  const db = c.get("db");
  const user = c.get("user");
  const row = db
    .prepare(
      "SELECT workspaces.id AS workspace_id, memberships.role AS role " +
        "FROM workspaces JOIN memberships ON memberships.workspace_id = workspaces.id " +
        "WHERE workspaces.slug = ? AND memberships.user_id = ?",
    )
    .get(slug, user.id) as { workspace_id: number; role: "owner" | "verifier" | "member" } | undefined;
  if (!row) return c.json({ error: "workspace not found", code: "not_found" }, 404);
  c.set("workspace", { id: row.workspace_id, slug, role: row.role });
  await next();
};
