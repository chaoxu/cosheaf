import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";
import type { Role } from "../shared/roles.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { getStoredPat, upsertUserFromForgejo, userFromSession, type User } from "./users.js";
import { TTLCache } from "./ttl-cache.js";

interface AuthResolution {
  user: User;
  forgejoToken: string;
}

const BEARER_TTL_MS = 30_000;
const BEARER_CACHE = new TTLCache<string, string>(BEARER_TTL_MS);

export function _seedBearerAuthCacheForTests(token: string, username: string): void {
  BEARER_CACHE.set(token, username, 60_000);
}

export function _resetBearerAuthCacheForTests(): void {
  BEARER_CACHE.clear();
}

function bearerToken(authHeader?: string): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

export async function resolveAuth(c: Context<AppEnv>): Promise<AuthResolution | null> {
  const db = c.get("db");
  const config = c.get("config");
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer) {
    let username = BEARER_CACHE.get(bearer);
    if (!username) {
      const fj = new Forgejo({ baseUrl: config.forgejoUrl, token: bearer });
      try {
        username = (await fj.getCurrentUser()).login;
      } catch (err) {
        if (err instanceof ForgejoError && (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
      BEARER_CACHE.set(bearer, username);
    }
    return { user: upsertUserFromForgejo(db, username), forgejoToken: bearer };
  }

  const sid = getCookie(c, "session");
  const user = sid ? userFromSession(db, sid) : null;
  if (!user) return null;
  const pat = getStoredPat(db, user.id, config.sessionSecret);
  return pat ? { user, forgejoToken: pat } : null;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await resolveAuth(c);
  if (!auth) return c.json({ error: "not authenticated", code: "unauthorized" }, 401);
  c.set("user", auth.user);
  c.set("forgejoToken", auth.forgejoToken);
  c.set("fjUser", new Forgejo({ baseUrl: c.get("config").forgejoUrl, token: auth.forgejoToken }));
  await next();
};

// In-process cache of Forgejo collaborator-permission lookups. Forgejo is SoT;
// this avoids a Forgejo round-trip on every workspace request. TTL is short so
// permission revocations propagate quickly enough for our use.
const PERM_TTL_MS = 30_000;
const PERM_CACHE = new TTLCache<string, Role | "none">(PERM_TTL_MS);

export function _resetPermCacheForTests(): void {
  PERM_CACHE.clear();
}

export function _seedPermCacheForTests(
  owner: string,
  repo: string,
  forgejoUsername: string,
  role: Role,
): void {
  PERM_CACHE.set(`${owner}/${repo}/${forgejoUsername}`, role, 60_000);
}

// Bypass the in-process role cache and re-fetch from Forgejo. Use on routes
// that mutate shared state (merge, branch-protection settings) so a
// freshly-demoted admin can't keep doing irreversible things for up to the
// cache TTL.
export const requireAdminFresh: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ws = c.get("workspace");
  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjName = c.get("user").username;
  const fresh = await fj.getRepoPermission(owner, ws.forgejoRepo, fjName);
  if (fresh !== "admin")
    return c.json({ error: "admin required", code: "forbidden" }, 403);
  PERM_CACHE.set(`${owner}/${ws.forgejoRepo}/${fjName}`, fresh);
  await next();
};

// Require the caller is workspace `admin` (i.e. Forgejo collaborator with the
// "owner" / admin role). Uses the cached role from requireMembership — for a
// fresh re-check on truly destructive ops (merge, delete repo), see
// `requireAdminFresh`.
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ws = c.get("workspace");
  if (ws.role !== "admin") {
    return c.json({ error: "owner required", code: "forbidden" }, 403);
  }
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
  const cached = PERM_CACHE.get(key);
  if (cached !== null) return cached;
  const p = await fj.getRepoPermission(owner, repo, forgejoUsername);
  PERM_CACHE.set(key, p);
  return p;
}

export const requireMembership = (param = "slug"): MiddlewareHandler<AppEnv> => async (c, next) => {
  const slug = c.req.param(param);
  if (!slug) return c.json({ error: "workspace required", code: "validation" }, 400);
  const db = c.get("db");
  const row = db
    .prepare("SELECT id, name, forgejo_repo, default_md_format FROM workspaces WHERE slug = ?")
    .get(slug) as
      | { id: number; name: string; forgejo_repo: string; default_md_format: string }
      | undefined;
  if (!row) return c.json({ error: "workspace not found", code: "not_found" }, 404);

  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjName = c.get("user").username;
  const role = await fetchRole(fj, owner, row.forgejo_repo, fjName);
  if (role === "none")
    return c.json({ error: "workspace not found", code: "not_found" }, 404);

  c.set("workspace", {
    id: row.id,
    slug,
    name: row.name,
    forgejoRepo: row.forgejo_repo,
    defaultMdFormat: row.default_md_format,
    role,
  });
  c.set("repoCtx", { fj, owner, repo: row.forgejo_repo });
  await next();
};
