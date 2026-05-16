import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";
import type { Role } from "../shared/roles.js";
import type { Forgejo } from "./forgejo.js";
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

// In-process cache of Forgejo collaborator-permission lookups. Forgejo is SoT;
// this avoids a Forgejo round-trip on every workspace request. TTL is short so
// permission revocations propagate quickly enough for our use.
interface PermCacheEntry { role: Role | "none"; expiresAt: number }
const PERM_CACHE = new Map<string, PermCacheEntry>();
const PERM_TTL_MS = 30_000;

export function _resetPermCacheForTests(): void {
  PERM_CACHE.clear();
}

export function _seedPermCacheForTests(
  owner: string,
  repo: string,
  forgejoUsername: string,
  role: Role,
): void {
  PERM_CACHE.set(`${owner}/${repo}/${forgejoUsername}`, {
    role,
    expiresAt: Date.now() + 60_000,
  });
}

// Bypass the in-process role cache and re-fetch from Forgejo. Use on routes
// that mutate shared state (merge, branch-protection settings) so a
// freshly-demoted admin can't keep doing irreversible things for up to the
// cache TTL.
export const requireAdminFresh: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const fjName = c.get("forgejoUsername");
  const fresh = await fj.getRepoPermission(owner, ws.forgejoRepo, fjName);
  if (fresh !== "admin")
    return c.json({ error: "admin required", code: "forbidden" }, 403);
  PERM_CACHE.set(`${owner}/${ws.forgejoRepo}/${fjName}`, {
    role: fresh,
    expiresAt: Date.now() + PERM_TTL_MS,
  });
  await next();
};

// Require the caller has at least `write` (i.e. `write` or `admin`) on the
// workspace. Read-only members can still hit GET/HEAD routes, but any
// mutation method is gated here. Uses the cached role from requireMembership.
export const requireWriteOnMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const ws = c.get("workspace");
  if (ws.role !== "write" && ws.role !== "admin") {
    return c.json({ error: "write access required", code: "forbidden" }, 403);
  }
  await next();
};

async function fetchRole(
  fj: Forgejo,
  owner: string,
  repo: string,
  forgejoUsername: string,
): Promise<Role | "none"> {
  const key = `${owner}/${repo}/${forgejoUsername}`;
  const now = Date.now();
  const cached = PERM_CACHE.get(key);
  if (cached && cached.expiresAt > now) return cached.role;
  const p = await fj.getRepoPermission(owner, repo, forgejoUsername);
  PERM_CACHE.set(key, { role: p, expiresAt: now + PERM_TTL_MS });
  return p;
}

export const requireMembership = (param = "slug"): MiddlewareHandler<AppEnv> => async (c, next) => {
  const slug = c.req.param(param);
  if (!slug) return c.json({ error: "workspace required", code: "validation" }, 400);
  const db = c.get("db");
  const row = db
    .prepare("SELECT id, name, forgejo_repo FROM workspaces WHERE slug = ?")
    .get(slug) as { id: number; name: string; forgejo_repo: string } | undefined;
  if (!row) return c.json({ error: "workspace not found", code: "not_found" }, 404);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const fjName = c.get("forgejoUsername");
  const role = await fetchRole(fj, owner, row.forgejo_repo, fjName);
  if (role === "none")
    return c.json({ error: "workspace not found", code: "not_found" }, 404);

  c.set("workspace", { id: row.id, slug, name: row.name, forgejoRepo: row.forgejo_repo, role });
  c.set("repoCtx", { fj, owner, repo: row.forgejo_repo, sudo: fjName });
  await next();
};
