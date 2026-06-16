import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.js";
import type { Role } from "../shared/roles.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import type { User } from "./users.js";
import { TTLCache } from "./ttl-cache.js";
import { FORGEJO_NAME_RE, workspaceSlug } from "../shared/conventions.js";
import { type DocumentFormatId, documentFormatFromTopics } from "../shared/document-format.js";

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

// Drop the cached username for a bearer that Forgejo just rejected. Called
// from the global 401 handler so a revoked PAT can't keep resolving from
// the cache for up to BEARER_TTL_MS after revocation.
export function invalidateBearerCache(token: string): void {
  BEARER_CACHE.delete(token);
}

function bearerToken(authHeader?: string): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

export const AUTH_COOKIE = "cosheaf_pat";

// PAT-only authentication. API clients and agents send the PAT as
// `Authorization: Bearer <pat>`; server-rendered pages (and same-origin
// EventSource, which sends the cookie) receive the same PAT through an HttpOnly
// cookie. There is no cosheaf-side user table or session record: the PAT is the
// credential. No `?pat=` query path — keeping the credential out of URLs/logs;
// re-add it scoped to a specific SSE handler if an off-cookie client ever needs it.
export async function resolveAuth(c: Context<AppEnv>): Promise<AuthResolution | null> {
  const config = c.get("config");
  const bearer = bearerToken(c.req.header("authorization")) ?? getCookie(c, AUTH_COOKIE) ?? null;
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

export function invalidateWorkspacePermissionCache(owner: string, repo: string, forgejoUsername: string): void {
  PERM_CACHE.delete(`${owner}/${repo}/${forgejoUsername}`);
}

// Bypass the in-process role cache and re-fetch from Forgejo. Use on routes
// that mutate shared state (merge, branch-protection settings) so a
// freshly-demoted admin can't keep doing irreversible things for up to the
// cache TTL.
export const requireAdminFresh: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ws = c.get("workspace");
  const fj = c.get("fjUser");
  const fjName = c.get("user").username;
  const fresh = await fj.getRepoPermission(ws.owner, ws.repo, fjName);
  if (fresh !== "admin")
    return c.json({ error: "admin required", code: "forbidden" }, 403);
  PERM_CACHE.set(`${ws.owner}/${ws.repo}/${fjName}`, fresh);
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

// Cached collaborator-role lookup. Shared by requireMembership and the
// server-rendered web path (resolveWebRepo) so both surfaces see the same
// role within the same TTL window.
export async function resolveRepoRole(
  fj: Forgejo,
  owner: string,
  repo: string,
  forgejoUsername: string,
): Promise<Role | "none"> {
  const key = `${owner}/${repo}/${forgejoUsername}`;
  return PERM_CACHE.getOrFetch(key, () => fj.getRepoPermission(owner, repo, forgejoUsername));
}

export const requireMembership = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo || !FORGEJO_NAME_RE.test(owner) || !FORGEJO_NAME_RE.test(repo))
    return c.json({ error: "workspace required", code: "validation" }, 400);
  const fj = c.get("fjUser");
  const fjName = c.get("user").username;
  const role = await resolveRepoRole(fj, owner, repo, fjName);
  if (role === "none")
    return c.json({ error: "workspace not found", code: "not_found" }, 404);

  const defaultMdFormat = await resolveWorkspaceFormat(fj, owner, repo);
  c.set("workspace", { owner, repo, slug: workspaceSlug(owner, repo), defaultMdFormat, role });
  c.set("repoCtx", { fj, owner, repo });
  await next();
};

// Same TTL discipline as the role cache — format changes propagate quickly
// enough, and a topic flip is a rare admin action.
const FORMAT_TTL_MS = 30_000;

// Cached per-workspace markdown format derived from repo topics; untagged
// repos fall back to the default (forgejo-passthrough). Cosheaf is a frontend
// over the forge, so visibility is never gated on a format topic being present.
const FORMAT_CACHE = new TTLCache<string, DocumentFormatId>(FORMAT_TTL_MS);

export function _resetFormatCacheForTests(): void {
  FORMAT_CACHE.clear();
}

export function _seedFormatCacheForTests(owner: string, repo: string, formatId: string): void {
  FORMAT_CACHE.set(`${owner}/${repo}`, formatId as DocumentFormatId, 60_000);
}

// Cached topics lookup shared with the web path.
export async function resolveWorkspaceFormat(
  fj: Forgejo,
  owner: string,
  repo: string,
): Promise<DocumentFormatId> {
  return FORMAT_CACHE.getOrFetch(`${owner}/${repo}`, async () =>
    documentFormatFromTopics(await fj.listRepoTopics(owner, repo)),
  );
}

// Cached workspace title (the Forgejo repo description) for the web chrome's
// Read-mode workspace identity (#147). Empty string when the repo has no
// description, so the chrome falls back to the owner/repo slug. Web-only — the
// typed API never needs it — and same 30s TTL as role/format. `getRepo` returns
// null on a 404, which caches as "" (→ slug fallback).
const TITLE_CACHE = new TTLCache<string, string>(FORMAT_TTL_MS);

export function _resetTitleCacheForTests(): void {
  TITLE_CACHE.clear();
}

export async function resolveWorkspaceTitle(fj: Forgejo, owner: string, repo: string): Promise<string> {
  return TITLE_CACHE.getOrFetch(`${owner}/${repo}`, async () => {
    try {
      const repoMeta = await fj.getRepo(owner, repo);
      return (repoMeta?.description ?? "").trim();
    } catch (_err) {
      // The title is a cosmetic Read-mode label; a forge hiccup must never break
      // page rendering. Fall back to the slug (empty title) and move on.
      return "";
    }
  });
}
