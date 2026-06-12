import type Database from "better-sqlite3";
import type { Context } from "hono";
import { documentFormatFromTopics, isFormatTopic } from "../../shared/document-format.js";
import type { Role } from "../../shared/roles.js";
import { Forgejo } from "../forgejo.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import { resolveAuth } from "../middleware.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { escapeHtml } from "./html-escape.js";
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
  if (!owner || !repo) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  if (owner !== config.forgejoOwner) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const fj = new Forgejo({ baseUrl: config.forgejoUrl, token: auth.forgejoToken });
  const role = await fj.getRepoPermission(owner, repo, auth.user.username);
  if (role === "none") {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const topics = await fj.listRepoTopics(owner, repo);
  if (!topics.some(isFormatTopic)) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const defaultMdFormat = documentFormatFromTopics(topics);
  const ws: WorkspaceContext = { slug: repo, role, defaultMdFormat };
  c.set("workspace", ws);
  c.set("repoCtx", { fj, owner, repo });
  return { ok: true, owner, repo, user: auth.user.username, fj, ws, db: c.get("db") };
}

// resolveWebRepo plus the write gate every mutating web handler needs:
// read-only members get the Forbidden page instead of the resolved repo.
export async function resolveWebRepoForWrite(c: Context<AppEnv>): Promise<WebRepoResult> {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx;
  if (ctx.ws.role === "read") return { ok: false, response: forbiddenPage(ctx.user) };
  return ctx;
}

export async function configReposForUser(c: Context<AppEnv>) {
  const config = c.get("config");
  const userFj = c.get("fjUser");
  const repos = await userFj.listUserRepos(config.forgejoOwner, { limit: 100 });
  return repos
    .filter((repo) => (repo.topics ?? []).some(isFormatTopic))
    .map((repo) => ({
      name: repo.name,
      description: repo.description ?? "",
      role: roleFromPermissions(repo.permissions),
    }))
    .filter((repo) => repo.role !== "none");
}

function roleFromPermissions(p: { admin?: boolean; push?: boolean; pull?: boolean } | undefined): Role | "none" {
  if (!p) return "none";
  if (p.admin) return "admin";
  if (p.push) return "write";
  if (p.pull) return "read";
  return "none";
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

export async function notFoundPage(user: string, message: string): Promise<Response> {
  return htmlResponse(pageShell({ title: "Not found", user, sidebar: globalSidebar("workspaces"), body: `<main class="page"><div class="empty">${escapeHtml(message)}</div></main>` }), 404);
}

export function badRequestPage(user: string, message: string): Response {
  return htmlResponse(pageShell({ title: "Bad request", user, sidebar: globalSidebar("workspaces"), body: `<main class="page"><div class="empty">${escapeHtml(message)}</div></main>` }), 400);
}

export function errorPage(user: string, message: string, status: number): Response {
  return htmlResponse(pageShell({ title: "Error", user, sidebar: globalSidebar("workspaces"), body: `<main class="page"><div class="empty">${escapeHtml(message)}</div></main>` }), status);
}

export function forbiddenPage(user: string): Response {
  return htmlResponse(pageShell({ title: "Forbidden", user, sidebar: globalSidebar("workspaces"), body: `<main class="page"><div class="empty">Forbidden</div></main>` }), 403);
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

export function repoHref(_owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(repo)}${suffix}`;
}

export function urlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function displayLogin(owner: string, login: string | null | undefined): string {
  if (!login) return DELETED_USER_LOGIN;
  return login === owner ? "repository" : login;
}

export function jsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function formatDate(value: string | number | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
