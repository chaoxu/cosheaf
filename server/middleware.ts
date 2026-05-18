import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types.js";
import type { Role } from "../shared/roles.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import type { User } from "./users.js";
import { TTLCache } from "./ttl-cache.js";
import { documentFormatFromTopics } from "../shared/document-format.js";

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

// EventSource can't set headers; the SSE route accepts the PAT via a
// `?pat=` query param as a narrowly-scoped fallback. The PAT is the
// credential either way — Forgejo validates it the same way.
function bearerFromQuery(c: Context<AppEnv>): string | null {
  const v = c.req.query("pat")?.trim();
  return v && v.length > 0 ? v : null;
}

// Bearer-only authentication. The SPA stores its PAT in localStorage and
// sends it as `Authorization: Bearer <pat>` on every request; agents do the
// same with their own Forgejo PAT. There is no cookie session and no
// cosheaf-side user table — the PAT is the credential.
export async function resolveAuth(c: Context<AppEnv>): Promise<AuthResolution | null> {
  const config = c.get("config");
  const bearer = bearerToken(c.req.header("authorization")) ?? bearerFromQuery(c);
  if (!bearer) return null;
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
  return { user: { username }, forgejoToken: bearer };
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
  const fresh = await fj.getRepoPermission(owner, ws.slug, fjName);
  if (fresh !== "admin")
    return c.json({ error: "admin required", code: "forbidden" }, 403);
  PERM_CACHE.set(`${owner}/${ws.slug}/${fjName}`, fresh);
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
  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjName = c.get("user").username;
  const role = await fetchRole(fj, owner, slug, fjName);
  if (role === "none")
    return c.json({ error: "workspace not found", code: "not_found" }, 404);

  const defaultMdFormat = await fetchWorkspaceFormat(fj, owner, slug);
  c.set("workspace", { slug, defaultMdFormat, role });
  c.set("repoCtx", { fj, owner, repo: slug });
  await next();
};

// In-process cache of the workspace's markdown format (read from the Forgejo
// repo topic). Same TTL discipline as the role cache — format changes
// propagate quickly enough, and a topic flip is a rare admin action.
const FORMAT_TTL_MS = 30_000;
const FORMAT_CACHE = new TTLCache<string, string>(FORMAT_TTL_MS);

export function _resetFormatCacheForTests(): void {
  FORMAT_CACHE.clear();
}

export function _seedFormatCacheForTests(slug: string, formatId: string): void {
  FORMAT_CACHE.set(slug, formatId, 60_000);
}

async function fetchWorkspaceFormat(fj: Forgejo, owner: string, slug: string): Promise<string> {
  const cached = FORMAT_CACHE.get(slug);
  if (cached !== null) return cached;
  const topics = await fj.listRepoTopics(owner, slug);
  const format = documentFormatFromTopics(topics);
  FORMAT_CACHE.set(slug, format);
  return format;
}
