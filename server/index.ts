import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "./types.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { SSEHub } from "./sse.js";
import { auth } from "./routes/auth.js";
import { handleAppError } from "./routes/error-handler.js";
import { members, workspaces } from "./routes/workspaces.js";
import { files } from "./routes/files.js";
import { branches } from "./routes/branches.js";
import { pulls } from "./routes/pulls.js";
import { issues } from "./routes/issues.js";
import { globalNotifications, notifications } from "./routes/notifications.js";
import { webhooks } from "./routes/webhooks.js";
import { web } from "./routes/web.js";
import { gitProxy } from "./routes/git-proxy.js";
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
  await next();
});

app.get("/api/v1/health", (c) =>
  c.json({
    ok: true,
    commit: process.env.COSHEAF_GIT_SHA ?? "unknown",
  }),
);

app.onError(handleAppError);

app.route("/api/v1", auth);
app.route("/api/v1/workspaces", workspaces);
app.route("/api/v1/repos", members);
app.route("/api/v1/repos", files);
app.route("/api/v1/repos", pulls);
app.route("/api/v1/repos", branches);
app.route("/api/v1/repos", issues);
app.route("/api/v1/repos", notifications);
app.route("/api/v1", globalNotifications);
app.route("/api/v1/webhooks", webhooks);

const distDir = path.resolve(process.cwd(), "dist");
const publicDir = path.resolve(process.cwd(), "public");
const publicAssetPaths = new Set(["/cosheaf-web.css", "/cosheaf-preferences.js", "/cosheaf-select.js", "/cosheaf-pr-diff-defaults.js", "/cosheaf-confirm.js", "/cosheaf-inbox.js", "/favicon.svg"]);
const coflatEditorDistDir = path.dirname(
  requireResolve("@chaoxu/coflat/style.css"),
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

app.use("/assets/*", compress());
app.use("/vendor/coflat/*", compress());
for (const assetPath of publicAssetPaths) app.use(assetPath, compress());

app.get("/vendor/coflat/*", async (c) => {
  const response = await serveCoflatEditorAsset(c.req.path);
  return response ?? c.json({ error: "not found" }, 404);
});

for (const assetPath of publicAssetPaths) {
  app.get(assetPath, async (c) => {
    const response = await servePublicOrDistFile(c.req.path);
    return response ?? c.json({ error: "not found" }, 404);
  });
}

app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 302));

app.get("/assets/*", async (c) => {
  const response = await serveDistFile(c.req.path);
  return response ?? c.json({ error: "not found" }, 404);
});

app.get("/fonts/*", async (c) => {
  const response = await servePublicOrDistFile(c.req.path);
  return response ?? c.json({ error: "not found" }, 404);
});

// Git Smart-HTTP proxy — mounted before the web routes so `/:owner/:repo.git/*`
// is handled as git transport, not a page route.
app.route("/", gitProxy);

app.route("/", web);

async function serveDistFile(requestPath: string): Promise<Response | null> {
  const resolvedPath = resolveDistPath(requestPath);
  if (!resolvedPath) return null;
  const body = await readFile(resolvedPath);
  return new Response(body, { headers: staticFileHeaders(resolvedPath, cacheControlForRequestPath(requestPath)) });
}

async function servePublicOrDistFile(requestPath: string): Promise<Response | null> {
  const publicPath = resolveStaticPath(publicDir, requestPath);
  if (publicPath) {
    const body = await readFile(publicPath);
    return new Response(body, { headers: staticFileHeaders(publicPath, "public, max-age=60") });
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
  const relativePath = decodedPath.replace(/^\/vendor\/coflat\/?/, "") || "editor.css";
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
  return new Response(body, { headers: staticFileHeaders(filePath, cacheControlForRequestPath(requestPath)) });
}

function staticFileHeaders(filePath: string, cacheControl: string): Record<string, string> {
  return {
    "cache-control": cacheControl,
    "content-type": contentTypeForPath(filePath),
    vary: "Accept-Encoding",
  };
}

function cacheControlForRequestPath(requestPath: string): string {
  if (requestPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (requestPath.startsWith("/fonts/")) return "public, max-age=31536000, immutable";
  if (requestPath.startsWith("/vendor/coflat/fonts/")) return "public, max-age=31536000, immutable";
  if (requestPath.startsWith("/vendor/coflat/")) return "public, max-age=86400";
  return "public, max-age=60";
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`forgejo: ${config.forgejoUrl}`);
  console.log(`data dir: ${config.dataDir}`);
});
