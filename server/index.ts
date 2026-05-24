import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { SSEHub } from "./sse.js";
import { auth } from "./routes/auth.js";
import { invalidateBearerCache } from "./middleware.js";
import { workspaces } from "./routes/workspaces.js";
import { files } from "./routes/files.js";
import { branches } from "./routes/branches.js";
import { pulls } from "./routes/pulls.js";
import { issues } from "./routes/issues.js";
import { notifications } from "./routes/notifications.js";
import { webhooks } from "./routes/webhooks.js";
import { web } from "./routes/web.js";
import { contentTypeForPath } from "./content-type.js";

const config = loadConfig();
const db = getDb(config);
// Admin-bound Forgejo client. Used by the webhook handler (no user context)
// and explicit provisioning paths. Normal user-facing workspace routes use the
// caller's PAT; COSHEAF_FORGEJO_TOKEN is kept non-admin.
const fjAdmin = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken });
const sse = new SSEHub();

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("config", config);
  c.set("fjAdmin", fjAdmin);
  c.set("sse", sse);
  const rewrite = ownerlessRepoRewrite(c.req.raw);
  if (rewrite.kind === "redirect") return c.redirect(rewrite.location, rewrite.status);
  if (rewrite.kind === "forward") return app.fetch(rewrite.request);
  await next();
});

app.get("/api/v1/health", (c) =>
  c.json({
    ok: true,
    commit: process.env.COSHEAF_GIT_SHA ?? "unknown",
  }),
);

// If a route handler bubbles a 401 from the backing forge, the caller's token
// was rejected (revoked, rotated). Surface a typed `pat_invalid` so browser
// islands redirect to login; agents see the same signal and re-acquire a token.
app.onError((err, c) => {
  if (err instanceof ForgejoError && err.status === 401) {
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (bearer) invalidateBearerCache(bearer);
    return c.json(
      { error: "Backend rejected the credentials; please log in again.", code: "pat_invalid" },
      401,
    );
  }
  throw err;
});

app.route("/api/v1", auth);
app.route("/api/v1/workspaces", workspaces);
app.route("/api/v1/w", files);
app.route("/api/v1/w", pulls);
app.route("/api/v1/w", branches);
app.route("/api/v1/w", issues);
app.route("/api/v1/w", notifications);
app.route("/api/v1/webhooks", webhooks);

const distDir = path.resolve(process.cwd(), "dist");
const publicDir = path.resolve(process.cwd(), "public");
const publicAssetPaths = new Set(["/cosheaf-web.css", "/cosheaf-preferences.js", "/cosheaf-pr-diff-defaults.js", "/favicon.svg"]);
const coflatEditorDistDir = path.dirname(
  requireResolve("@chaoxu/coflat-editor/style.css"),
);
if (process.env.NODE_ENV !== "production") {
  app.get("/node_modules/*", async (c) => {
    const viteOrigin = process.env.COSHEAF_VITE_ORIGIN ?? "http://localhost:5173";
    const response = await fetch(new URL(c.req.path, viteOrigin));
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? contentTypeForPath(c.req.path) },
    });
  });
}

app.get("/vendor/coflat-editor/*", async (c) => {
  const response = await serveCoflatEditorAsset(c.req.path);
  return response ?? c.json({ error: "not found" }, 404);
});

for (const assetPath of publicAssetPaths) {
  app.get(assetPath, async (c) => {
    const response = await servePublicOrDistFile(c.req.path);
    return response ?? c.json({ error: "not found" }, 404);
  });
}

app.get("/assets/*", async (c) => {
  const response = await serveDistFile(c.req.path);
  return response ?? c.json({ error: "not found" }, 404);
});

app.route("/", web);

async function serveDistFile(requestPath: string): Promise<Response | null> {
  const resolvedPath = resolveDistPath(requestPath);
  if (!resolvedPath) return null;
  const body = await readFile(resolvedPath);
  return new Response(body, { headers: { "content-type": contentTypeForPath(resolvedPath) } });
}

async function servePublicOrDistFile(requestPath: string): Promise<Response | null> {
  const publicPath = resolveStaticPath(publicDir, requestPath);
  if (publicPath) {
    const body = await readFile(publicPath);
    return new Response(body, { headers: { "content-type": contentTypeForPath(publicPath) } });
  }
  return serveDistFile(requestPath);
}

async function serveCoflatEditorAsset(requestPath: string): Promise<Response | null> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch (_error) {
    return null;
  }
  const relativePath = decodedPath.replace(/^\/vendor\/coflat-editor\/?/, "") || "editor.css";
  if (!relativePath || relativePath.split(/[\\/]/).includes("..")) return null;
  const filePath = path.resolve(coflatEditorDistDir, relativePath);
  if (filePath !== coflatEditorDistDir && !filePath.startsWith(`${coflatEditorDistDir}${path.sep}`)) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
  } catch (_error) {
    return null;
  }
  const body = await readFile(filePath);
  return new Response(body, { headers: { "content-type": contentTypeForPath(filePath) } });
}

function resolveDistPath(requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch (_error) {
    return null;
  }
  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.split(/[\\/]/).includes("..")) return null;

  const filePath = path.resolve(distDir, relativePath);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) return null;

  let stat;
  try {
    stat = statSync(filePath);
  } catch (_error) {
    return null;
  }
  if (stat.isDirectory()) return null;
  return filePath;
}

function resolveStaticPath(root: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch (_error) {
    return null;
  }
  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.split(/[\\/]/).includes("..")) return null;
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? filePath : null;
  } catch (_error) {
    return null;
  }
}

function requireResolve(id: string): string {
  return fileURLToPath(import.meta.resolve(id));
}

function ownerlessRepoRewrite(request: Request):
  | { kind: "none" }
  | { kind: "redirect"; location: string; status: 307 | 308 }
  | { kind: "forward"; request: Request } {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const [first, second] = parts;
  if (!first || first === "login" || first === "logout" || first === "account" || first === "assets" || first === "api" || publicAssetPaths.has(url.pathname)) return { kind: "none" };

  const internalRewrite = request.headers.get("x-cosheaf-internal-owner-rewrite");
  if (first === config.forgejoOwner && second && !internalRewrite) {
    return {
      kind: "redirect",
      location: `/${parts.slice(1).map(encodeURIComponent).join("/")}${url.search}`,
      status: request.method === "GET" ? 308 : 307,
    };
  }

  if (first !== config.forgejoOwner && !internalRewrite && isOwnerlessRepoPath(parts)) {
    const internalUrl = new URL(request.url);
    internalUrl.pathname = `/${encodeURIComponent(config.forgejoOwner)}${url.pathname}`;
    const headers = new Headers(request.headers);
    headers.set("x-cosheaf-internal-owner-rewrite", "1");
    return { kind: "forward", request: cloneForUrl(request, internalUrl, headers) };
  }

  return { kind: "none" };
}

function isOwnerlessRepoPath(parts: readonly string[]): boolean {
  if (parts.length === 1) return true;
  return ["_edit", "activity", "branches", "commits", "issues", "pulls", "raw", "settings", "src"].includes(parts[1] ?? "");
}

function cloneForUrl(request: Request, url: URL, headers: Headers): Request {
  if (request.method === "GET" || request.method === "HEAD") {
    return new Request(url, { headers, method: request.method });
  }
  return new Request(url, {
    body: request.body,
    headers,
    method: request.method,
  });
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`forgejo: ${config.forgejoUrl} (owner=${config.forgejoOwner})`);
  console.log(`data dir: ${config.dataDir}`);
});
