import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { FORGEJO_NAME_RE, workspaceSlug } from "../shared/conventions.js";
import { type DocumentFormatId, documentFormatFromTopics } from "../shared/document-format.js";
import type { Role } from "../shared/roles.js";
import { type ResolvedApiToken, resolveApiToken } from "./api-tokens.js";
import type { CollaborationClient } from "./collaboration-client.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { ForgejoWorkspaceBackend } from "./forgejo-backend.js";
import { resolveLocalWorkspace } from "./local/local-mode.js";
import { localCollaborationClient } from "./local/origin-collaboration-client.js";
import { TTLCache } from "./ttl-cache.js";
import type { AppEnv } from "./types.js";
import type { User } from "./users.js";

interface AuthResolution {
  user: User;
  forgejoToken: string;
}

// One 30s TTL for the auth-path in-process caches (bearer→user, repo-permission,
// and (owner,repo)→format/title). Kept as one value so the documented "cached
// in-process for 30s" behavior can't drift between them.
const AUTH_CACHE_TTL_MS = 30_000;
const BEARER_TTL_MS = AUTH_CACHE_TTL_MS;
const BEARER_CACHE = new TTLCache<string, ResolvedApiToken>(BEARER_TTL_MS);

export function _seedBearerAuthCacheForTests(token: string, username: string): void {
  BEARER_CACHE.set(token, { username, forgejoToken: token }, 60_000);
}

export function _resetBearerAuthCacheForTests(): void {
  BEARER_CACHE.clear();
}

// Drop the cached bearer resolution after a backend 401. Called from the
// global 401 handler so a revoked backend credential can't keep resolving from
// the cache for up to BEARER_TTL_MS after revocation.
export function invalidateBearerCache(token: string): void {
  BEARER_CACHE.delete(token);
}

export function bearerToken(authHeader?: string): string | null {
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authHeader ?? "");
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token || null;
}

export const AUTH_COOKIE = "cosheaf_pat";

// API clients and agents send an opaque Cosheaf token as
// `Authorization: Bearer <token>` or Gitea/tea's
// `Authorization: token <token>`; server-rendered pages (and same-origin
// EventSource, which sends the cookie) receive the same token through an
// HttpOnly cookie. Cosheaf resolves that token to the backend Forgejo
// credential internally. Direct Forgejo tokens are migration-only behind
// COSHEAF_ACCEPT_FORGEJO_BEARER=1. No `?pat=` query path — keeping credentials
// out of URLs/logs; re-add it scoped to a specific SSE handler if an off-cookie
// client ever needs it.
export async function resolveAuth(c: Context<AppEnv>): Promise<AuthResolution | null> {
  const config = c.get("config");
  const bearer = bearerToken(c.req.header("authorization")) ?? getCookie(c, AUTH_COOKIE) ?? null;
  if (!bearer) return null;
  // Return a cache hit WITHOUT re-setting: re-setting slides the TTL forward on
  // every request, so an actively-used token would never age out and the
  // BEARER_TTL_MS revocation backstop would be unbounded. Only a fresh
  // resolution (miss) seeds the cache, giving a fixed window from first use.
  const cached = BEARER_CACHE.get(bearer);
  if (cached) return { user: { username: cached.username }, forgejoToken: cached.forgejoToken };
  let resolved = resolveApiToken(c.get("db"), bearer);
  if (!resolved && process.env.COSHEAF_ACCEPT_FORGEJO_BEARER === "1") {
    const fj = new Forgejo({ baseUrl: config.forgejoUrl, token: bearer });
    try {
      const username = (await fj.getCurrentUser()).login;
      resolved = { username, forgejoToken: bearer };
    } catch (err) {
      if (err instanceof ForgejoError && (err.status === 401 || err.status === 403)) return null;
      throw err;
    }
  }
  if (!resolved) return null;
  BEARER_CACHE.set(bearer, resolved);
  return { user: { username: resolved.username }, forgejoToken: resolved.forgejoToken };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Local Workbench: the single local person is the fixed identity; there is no
  // token and no Forgejo client. Never emits a 401 (the islands' api.ts bounces
  // to /login on unauthorized/pat_invalid, which a local app must avoid).
  if (isLocalMode(c)) {
    c.set("user", { username: c.get("localRegistry").user });
    c.set("forgejoToken", "");
    return next();
  }
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
const PERM_TTL_MS = AUTH_CACHE_TTL_MS;
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
  // Local Workbench has no forge client to re-check against, and the single local
  // person is admin on their own folder (resolveLocalWorkspace returns role
  // "admin"). The connected core enforces admin on the actual write, so gate on
  // the resolved workspace role instead of a fresh forge round-trip.
  if (isLocalMode(c)) {
    if (ws.role !== "admin") return c.json({ error: "admin required", code: "forbidden" }, 403);
    return next();
  }
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
  if (isLocalMode(c)) {
    const resolved = resolveLocalWorkspace(c.get("localRegistry"), owner, repo);
    if (!resolved) return c.json({ error: "workspace not found", code: "not_found" }, 404);
    c.set("workspace", resolved.ws);
    // Local collaboration source (#262/#268): the connected core via the Origin
    // API, or a not-connected sentinel the migrated typed routes surface as a
    // 404/Connect prompt. Mirrors resolveWebRepo's local branch so the typed API
    // and the web pages share one client.
    c.set("repoCtx", {
      backend: resolved.entry.backend,
      collab: localCollaborationClient(resolved.entry),
      owner,
      repo,
    });
    return next();
  }
  const fj = c.get("fjUser");
  const fjName = c.get("user").username;
  const role = await resolveRepoRole(fj, owner, repo, fjName);
  if (role === "none")
    return c.json({ error: "workspace not found", code: "not_found" }, 404);

  const defaultMdFormat = await resolveWorkspaceFormat(fj, owner, repo);
  c.set("workspace", { owner, repo, slug: workspaceSlug(owner, repo), defaultMdFormat, role });
  // The Forgejo client structurally satisfies CollaborationClient, so hosted
  // `collab` is just `fj` — collaboration routes migrating off `ctx.fj` onto
  // `ctx.collab` (#262) see no behavior change. Local injects an Origin-backed
  // impl instead.
  c.set("repoCtx", { backend: new ForgejoWorkspaceBackend(fj), fj, collab: fj, owner, repo });
  await next();
};

// True when the request is served by the local Workbench (single on-disk folder).
export function isLocalMode(c: Context<AppEnv>): boolean {
  return c.get("config").mode === "local";
}

// Accessor for the raw Forgejo client used by hosted-only code paths. `repoCtx.fj`
// is undefined in local mode, so callers must guard on `isLocalMode(c)` before
// reaching here (some typed routes are mounted in BOTH modes but only touch the
// forge client on their hosted branch — e.g. post-merge head-branch cleanup and
// the format-topic reindex). Asserting `fj` keeps those destructure sites
// unchanged while the type stays honest.
export function repoCtxForgejo(c: Context<AppEnv>): { fj: Forgejo; owner: string; repo: string } {
  const { fj, owner, repo } = c.get("repoCtx");
  if (!fj) throw new Error("forgejo client unavailable: this code path is hosted-only and must not run in local mode");
  return { fj, owner, repo };
}

// The collaboration seam accessor (#262): the forge (hosted) or the bound core
// (local), plus owner/repo. Collaboration routes call this instead of
// repoCtxForgejo as they migrate, so the same route serves both modes.
export function repoCtxCollab(c: Context<AppEnv>): { collab: CollaborationClient; owner: string; repo: string } {
  const { collab, owner, repo } = c.get("repoCtx");
  if (!collab) throw new Error("collaboration client unavailable: no forge and no connected core for this workspace");
  return { collab, owner, repo };
}

// Same TTL discipline as the role cache — format changes propagate quickly
// enough, and a topic flip is a rare admin action.
const FORMAT_TTL_MS = AUTH_CACHE_TTL_MS;

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

export function _resetMiddlewareCachesForTests(): void {
  _resetBearerAuthCacheForTests();
  _resetPermCacheForTests();
  _resetFormatCacheForTests();
  _resetTitleCacheForTests();
}

export function _seedTitleCacheForTests(owner: string, repo: string, title: string): void {
  TITLE_CACHE.set(`${owner}/${repo}`, title, 60_000);
}

export function invalidateWorkspaceTitleCache(owner: string, repo: string): void {
  TITLE_CACHE.delete(`${owner}/${repo}`);
}

export function invalidateWorkspaceCaches(owner: string, repo: string): void {
  const rolePrefix = `${owner}/${repo}/`;
  for (const key of [...PERM_CACHE.keys()]) {
    if (key.startsWith(rolePrefix)) PERM_CACHE.delete(key);
  }
  FORMAT_CACHE.delete(`${owner}/${repo}`);
  invalidateWorkspaceTitleCache(owner, repo);
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
