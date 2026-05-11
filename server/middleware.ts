import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";
import type { Role } from "../shared/roles.js";
import { userFromSession, userFromToken, ensureForgejoProxy } from "./users.js";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.get("db");
  const auth = c.req.header("authorization");
  let user = null;
  if (auth?.startsWith("Bearer ")) {
    user = userFromToken(db, auth.slice("Bearer ".length).trim());
  }
  if (!user) {
    const sid = getCookie(c, "session");
    if (sid) user = userFromSession(db, sid);
  }
  if (!user) return c.json({ error: "not authenticated", code: "unauthorized" }, 401);
  c.set("user", user);
  const fj = c.get("forgejo");
  const fjName = await ensureForgejoProxy(db, fj, user);
  c.set("forgejoUsername", fjName);
  await next();
};

export const requireMembership = (param = "slug"): MiddlewareHandler<AppEnv> => async (c, next) => {
  const slug = c.req.param(param);
  if (!slug) return c.json({ error: "workspace required", code: "validation" }, 400);
  const db = c.get("db");
  const user = c.get("user");
  const row = db
    .prepare(
      "SELECT workspaces.id AS id, workspaces.name AS name, workspaces.forgejo_repo AS forgejo_repo, memberships.role AS role " +
        "FROM workspaces JOIN memberships ON memberships.workspace_id = workspaces.id " +
        "WHERE workspaces.slug = ? AND memberships.user_id = ?",
    )
    .get(slug, user.id) as
    | { id: number; name: string; forgejo_repo: string; role: Role }
    | undefined;
  if (!row) return c.json({ error: "workspace not found", code: "not_found" }, 404);
  c.set("workspace", { id: row.id, slug, name: row.name, forgejoRepo: row.forgejo_repo, role: row.role });
  await next();
};
