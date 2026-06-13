import type Database from "better-sqlite3";
import type { Context } from "hono";
import { FORGEJO_NAME_RE, workspaceSlug } from "../../shared/conventions.js";
import { Forgejo } from "../forgejo.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import { resolveAuth, resolveRepoRole, resolveWorkspaceFormat } from "../middleware.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { listVisibleWorkspaceRepos, roleFromPermissions } from "../workspace-discovery.js";
import { html, type Html, raw } from "./web-html.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export interface WebCtx {
  owner: string;
  repo: string;
  user: string;
  fj: Forgejo;
  ws: WorkspaceContext;
  db: Database.Database;
}

export type WebRepoResult = { ok: true } & WebCtx | { ok: false; response: Response };

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
  const format = await resolveWorkspaceFormat(fj, owner, repo);
  const ws: WorkspaceContext = { owner, repo, slug: workspaceSlug(owner, repo), role, defaultMdFormat: format.format };
  c.set("workspace", ws);
  c.set("repoCtx", { fj, owner, repo });
  return { ok: true, owner, repo, user: auth.user.username, fj, ws, db: c.get("db") };
}

// resolveWebRepo plus the write gate every mutating web handler needs.
// Read-only members get the same 404 "Repository not found" page as
// non-members: a distinct 403 would leak that the caller holds read access to
// a private repo, letting them enumerate repos by status code. (The typed JSON
// API still returns 403 via requireWriteOnMutation — machine clients are a
// different threat model.)
export async function resolveWebRepoForWrite(c: Context<AppEnv>): Promise<WebRepoResult> {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx;
  if (ctx.ws.role === "read") return { ok: false, response: await notFoundPage(ctx.user, "Repository not found") };
  return ctx;
}

// resolveWebRepo plus an admin gate. Any non-admin role (read or write) gets
// the same 404 as a non-member, for the same anti-enumeration reason as
// resolveWebRepoForWrite. Use for admin-only web pages/POSTs (settings, repo
// deletion, PR merge).
export async function resolveWebRepoForAdmin(c: Context<AppEnv>): Promise<WebRepoResult> {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx;
  if (ctx.ws.role !== "admin") return { ok: false, response: await notFoundPage(ctx.user, "Repository not found") };
  return ctx;
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
  return htmlResponse(pageShell({ title, user, sidebar: globalSidebar("workspaces"), body: html`<main class="page"><div class="empty">${message}</div></main>` }), status);
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
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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

export function positiveIntFields(value: unknown): number[] {
  return stringFields(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export function validBranchName(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[A-Za-z0-9._/-]+$/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("/") &&
      !value.endsWith("/"),
  );
}

export function repoHref(owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function urlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function displayLogin(login: string | null | undefined): string {
  return login || DELETED_USER_LOGIN;
}

// JSON destined for a <script type="application/json"> body. Entity-escaping
// would corrupt it, so mark it raw; `<` is JS-escaped instead to keep
// "</script>" out of the payload.
export function jsonScript(value: unknown): Html {
  return raw(JSON.stringify(value).replaceAll("<", "\\u003c"));
}

export function formatDate(value: string | number | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
