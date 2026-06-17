import type Database from "better-sqlite3";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { FORGEJO_NAME_RE, workspaceSlug } from "../../shared/conventions.js";
import { Forgejo } from "../forgejo.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import { AUTH_COOKIE, resolveAuth, resolveRepoRole, resolveWorkspaceFormat, resolveWorkspaceTitle } from "../middleware.js";
import type { LocaleId, T } from "../../shared/i18n/index.js";
import type { Role } from "../../shared/roles.js";
import { TTLCache } from "../ttl-cache.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { listVisibleWorkspaceRepos, roleFromPermissions } from "../workspace-discovery.js";
import { forgeAvatarSrc } from "./avatar.js";
import { parsePositiveIntId } from "./query-params.js";
import { html, type Html, raw } from "./web-html.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export interface WebCtx {
  owner: string;
  repo: string;
  user: string;
  fj: Forgejo;
  ws: WorkspaceContext;
  db: Database.Database;
  // The workspace's display title (Forgejo repo description), or "" when none.
  // Drives the Read-mode workspace identity in the chrome (#147); the chrome
  // falls back to the owner/repo slug when empty.
  wsTitle: string;
  // The signed-in user's same-origin avatar src for the sidebar identity (#177),
  // or null when they have no uploaded avatar (the chrome shows initials).
  userAvatarSrc: string | null;
  // Per-request UI locale and a locale-bound translate, threaded into repo-page
  // chrome/renderers (no AsyncLocalStorage).
  locale: LocaleId;
  t: T;
}

// The current user's avatar src, cached by bearer so the chrome doesn't re-fetch
// the user object on every page (#177). The cache stores "" as the sentinel for
// "no upload" (TTLCache.get returns null on a miss, so null can't double as a
// real value); callers see null for both no-upload and miss-then-no-upload.
const CURRENT_USER_AVATAR_CACHE = new TTLCache<string, string>(60_000);
export async function currentUserAvatarSrc(fj: Forgejo, bearer: string): Promise<string | null> {
  const cached = CURRENT_USER_AVATAR_CACHE.get(bearer);
  if (cached !== null) return cached || null;
  const src = await fj
    .getCurrentUser()
    .then((me) => forgeAvatarSrc(me))
    .catch(() => null);
  CURRENT_USER_AVATAR_CACHE.set(bearer, src ?? "");
  return src;
}

// Drop the cached avatar for a bearer right after that user uploads/removes their
// picture, so the chrome reflects the change on the next page instead of lagging
// up to the cache TTL (#177).
export function invalidateCurrentUserAvatar(bearer: string): void {
  CURRENT_USER_AVATAR_CACHE.delete(bearer);
}

export type WebRepoResult = { ok: true } & WebCtx | { ok: false; response: Response };

// The browser-facing origin (scheme://host) cosheaf should present. A configured
// public origin wins; otherwise we derive it from the request, honoring forwarded
// headers only when a trusted proxy hop is configured. Used for CSRF checks,
// secure cookies, and clone URLs that point at cosheaf, not the backing Forgejo.
export function requestOrigin(c: Context<AppEnv>): string {
  const publicOrigin = c.get("config")?.publicOrigin;
  if (publicOrigin) return publicOrigin;
  const url = new URL(c.req.url);
  const trustedProxyHops = c.get("config")?.trustedProxyHops ?? 0;
  const proto = forwardedHeaderValue(c.req.header("x-forwarded-proto"), trustedProxyHops) ?? url.protocol.replace(":", "");
  const host = forwardedHeaderValue(c.req.header("x-forwarded-host"), trustedProxyHops) ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}

function forwardedHeaderValue(header: string | undefined, trustedProxyHops: number): string | null {
  if (trustedProxyHops <= 0) return null;
  const parts = (header ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length < trustedProxyHops) return null;
  return parts[parts.length - trustedProxyHops];
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch (_err) {
    return null;
  }
}

// Set the cosheaf_pat session cookie (the user's minted Forgejo PAT). `secure`
// is derived from the proxy-aware origin so the flag is set behind a
// TLS-terminating reverse proxy (where c.req.url is the internal http URL) and
// stays unset over plain http in local dev.
export function setAuthCookie(c: Context<AppEnv>, pat: string): void {
  setCookie(c, AUTH_COOKIE, pat, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: requestOrigin(c).startsWith("https://"),
  });
}

// The client IP for rate-limiting, read from X-Forwarded-For only as far as the
// configured number of trusted reverse-proxy hops. With 0 hops (no trusted
// proxy, e.g. local dev) X-Forwarded-For is fully client-controlled, so it is
// ignored and callers share one "unknown" bucket — fail-closed, never
// bypassable by spoofing the header. Behind the lab's single Caddy,
// trustedProxyHops=1 selects the entry Caddy appended (the real client), which
// an upstream client cannot forge past.
export function clientIp(c: Context<AppEnv>, trustedProxyHops: number): string {
  if (trustedProxyHops <= 0) return "unknown";
  const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "unknown";
  if (parts.length < trustedProxyHops) return "unknown";
  return parts[parts.length - trustedProxyHops];
}

export async function resolveWebAuth(c: Context<AppEnv>): Promise<Awaited<ReturnType<typeof resolveAuth>>> {
  const auth = await resolveAuth(c);
  if (!auth) return null;
  c.set("user", auth.user);
  c.set("forgejoToken", auth.forgejoToken);
  c.set("fjUser", new Forgejo({ baseUrl: c.get("config").forgejoUrl, token: auth.forgejoToken }));
  return auth;
}

export async function resolveWebRepo(c: Context<AppEnv>): Promise<WebRepoResult> {
  const auth = await resolveWebAuth(c);
  if (!auth) return { ok: false, response: redirect("/login") };
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const config = c.get("config");
  if (!owner || !repo || !FORGEJO_NAME_RE.test(owner) || !FORGEJO_NAME_RE.test(repo)) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const fj = new Forgejo({ baseUrl: config.forgejoUrl, token: auth.forgejoToken });
  const role = await resolveRepoRole(fj, owner, repo, auth.user.username);
  if (role === "none") {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  // Cosheaf is a frontend over the forge: any repo the caller can read is a
  // valid workspace. Untagged repos open as forgejo-passthrough — the format
  // falls back via documentFormatFromTopics; we no longer gate on a
  // `cosheaf-format-*` topic being present.
  const defaultMdFormat = await resolveWorkspaceFormat(fj, owner, repo);
  const ws: WorkspaceContext = { owner, repo, slug: workspaceSlug(owner, repo), role, defaultMdFormat };
  c.set("workspace", ws);
  c.set("repoCtx", { fj, owner, repo });
  const [wsTitle, userAvatarSrc] = await Promise.all([
    resolveWorkspaceTitle(fj, owner, repo),
    currentUserAvatarSrc(fj, auth.forgejoToken),
  ]);
  return { ok: true, owner, repo, user: auth.user.username, fj, ws, db: c.get("db"), wsTitle, userAvatarSrc, locale: c.get("locale"), t: c.get("t") };
}

// resolveWebRepo plus a role gate. A caller whose role fails `allow` gets the
// SAME 404 "Repository not found" page as a non-member — never a distinct 403,
// which would let them enumerate private repos they hold some access to by
// status code. (The typed JSON API still returns 403 via requireWriteOnMutation
// / requireAdmin — machine clients are a different threat model.)
async function resolveWithMinRole(
  c: Context<AppEnv>,
  allow: (role: Role) => boolean,
): Promise<WebRepoResult> {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx;
  if (!allow(ctx.ws.role)) return { ok: false, response: await notFoundPage(ctx.user, "Repository not found") };
  return ctx;
}

// The write gate every mutating web handler needs (read-only members get 404).
export function resolveWebRepoForWrite(c: Context<AppEnv>): Promise<WebRepoResult> {
  return resolveWithMinRole(c, (role) => role === "write" || role === "admin");
}

// The admin gate for admin-only web pages/POSTs (settings, repo deletion, PR
// merge); any non-admin role gets 404.
export function resolveWebRepoForAdmin(c: Context<AppEnv>): Promise<WebRepoResult> {
  return resolveWithMinRole(c, (role) => role === "admin");
}

// Higher-order wrappers that fold the resolve-then-check-ok preamble every web
// handler shares. Register as `web.get(path, webRoute(async (c, ctx) => …))`:
// the wrapper resolves the repo (404s a caller without the required role) and
// then invokes the handler with the ready WebCtx, so handlers never repeat the
// `if (!ctx.ok) return ctx.response` guard.
type WebHandler = (c: Context<AppEnv>, ctx: WebCtx) => Response | Promise<Response>;

export function rejectCrossOriginMutation(c: Context<AppEnv>, opts: { allowOriginless?: boolean } = {}): Response | null {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return null;
  const expected = normalizedOrigin(requestOrigin(c));
  if (!expected) return new Response("forbidden", { status: 403 });
  const origin = c.req.header("origin");
  if (origin) {
    const actual = normalizedOrigin(origin);
    if (!actual || actual !== expected) return new Response("forbidden", { status: 403 });
    return null;
  }
  const referer = c.req.header("referer");
  if (!referer) return opts.allowOriginless ? null : new Response("forbidden", { status: 403 });
  const actual = normalizedOrigin(referer);
  if (!actual) return new Response("forbidden", { status: 403 });
  if (actual && actual !== expected) return new Response("forbidden", { status: 403 });
  return null;
}

function makeWebRoute(resolve: (c: Context<AppEnv>) => Promise<WebRepoResult>) {
  return (handler: WebHandler) =>
    async (c: Context<AppEnv>): Promise<Response> => {
      const crossOrigin = rejectCrossOriginMutation(c);
      if (crossOrigin) return crossOrigin;
      const ctx = await resolve(c);
      if (!ctx.ok) return ctx.response;
      return handler(c, ctx);
    };
}

export const webRoute = makeWebRoute(resolveWebRepo);
export const webRouteForWrite = makeWebRoute(resolveWebRepoForWrite);
export const webRouteForAdmin = makeWebRoute(resolveWebRepoForAdmin);

type WebAuth = NonNullable<Awaited<ReturnType<typeof resolveWebAuth>>>;
type GlobalHandler = (c: Context<AppEnv>, auth: WebAuth) => Response | Promise<Response>;

// Wrapper for non-repo signed-in pages (home, account, notifications, new repo,
// avatar/profile POSTs): folds the `resolveWebAuth → redirect("/login")`
// preamble the global handlers share, mirroring webRoute for repo pages so the
// auth gate can't be forgotten. The resolved auth (and its `c.set` side effects:
// user/forgejoToken/fjUser) is passed through. NOT for /login, /logout, or
// public routes like /forge-avatars/* that have no auth gate.
export function globalRoute(handler: GlobalHandler) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const crossOrigin = rejectCrossOriginMutation(c);
    if (crossOrigin) return crossOrigin;
    const auth = await resolveWebAuth(c);
    if (!auth) return redirect("/login");
    return handler(c, auth);
  };
}

export async function configReposForUser(c: Context<AppEnv>) {
  const userFj = c.get("fjUser");
  const repos = await listVisibleWorkspaceRepos(userFj);
  return repos
    .map((repo) => ({
      owner: repo.owner.login,
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description ?? "",
      private: repo.private ?? false,
      role: roleFromPermissions(repo.permissions),
    }))
    .filter((repo) => repo.role !== "none");
}

export { parseListState, type ListState as WebListState } from "./query-params.js";

export function queryText(c: Context<AppEnv>, name: string): string {
  return c.req.query(name)?.trim() ?? "";
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function messagePage(title: string, user: string, message: string, status: number): Response {
  return htmlResponse(pageShell({ title, user, sidebar: globalSidebar("workspaces", user), body: html`<main class="page"><div class="empty">${message}</div></main>` }), status);
}

export async function notFoundPage(user: string, message: string): Promise<Response> {
  return messagePage("Not found", user, message, 404);
}

export function badRequestPage(user: string, message: string): Response {
  return messagePage("Bad request", user, message, 400);
}

export function errorPage(user: string, message: string, status: number): Response {
  return messagePage("Error", user, message, status);
}

export function forbiddenPage(user: string): Response {
  return messagePage("Forbidden", user, "Forbidden", 403);
}

export function safeWebRedirect(raw: string | null): string | null {
  if (!raw) return null;
  // Same-origin path only: a single leading slash followed by a char that is
  // neither / nor \ — browsers treat "\" as "/" in the authority, so "/\evil.com"
  // is an open redirect just like "//evil.com".
  if (!/^\/($|[^/\\])/.test(raw)) return null;
  return raw;
}

export function positiveInt(raw: string | undefined): number | null {
  return parsePositiveIntId(raw);
}

export function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

export function textField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function stringFields(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

export function positiveIntFields(value: unknown): number[] | null {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const ids = new Set<number>();
  for (const item of values) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const id = positiveInt(trimmed);
    if (id === null) return null;
    ids.add(id);
  }
  return [...ids];
}

export function repoHref(owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export { urlPath } from "../../shared/url.js";

export function displayLogin(login: string | null | undefined): string {
  return login || DELETED_USER_LOGIN;
}

// A machine-readable <time> that the client reformatter (cosheaf-preferences.js)
// rewrites to the user's chosen format — Relative ("3d") by default or Absolute
// short ("6/13/26") — in their local timezone, also fixing the server-timezone
// bug of a pre-baked string. The server-rendered text is the Absolute-short
// fallback; `datetime` carries the ISO source and `title` the full absolute
// timestamp for hover. Use this everywhere a date is shown (list rows, bylines,
// timelines) so the date preference applies consistently.
export function timeEl(value: string | number | null | undefined): Html {
  if (!value) return raw("");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return raw("");
  const iso = date.toISOString();
  const short = date.toLocaleDateString("en-US", { year: "2-digit", month: "numeric", day: "numeric" });
  const full = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return html`<time data-cosheaf-time datetime="${iso}" title="${full}">${short}</time>`;
}
