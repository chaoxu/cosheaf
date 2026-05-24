import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

// If a route handler bubbles a 401 from the backing forge, the caller's token
// was rejected (revoked, rotated). Surface a typed `pat_invalid` so the SPA can
// drop the stored token and bounce to login; agents see the same signal and
// re-acquire a token.
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
app.route("/", web);

const distDir = path.resolve(process.cwd(), "dist");
if (existsSync(path.join(distDir, "index.html"))) {
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not found" }, 404);
    }
    const response = await serveDistFile(c.req.path);
    if (response) return response;
    await next();
  });
}

async function serveDistFile(requestPath: string): Promise<Response | null> {
  const resolvedPath = resolveDistPath(requestPath);
  if (!resolvedPath) return null;
  const body = await readFile(resolvedPath);
  return new Response(body, { headers: { "content-type": contentType(resolvedPath) } });
}

function resolveDistPath(requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch (_error) {
    return null;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.split(/[\\/]/).includes("..")) return null;

  let filePath = path.resolve(distDir, relativePath);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) return null;

  let stat;
  try {
    stat = statSync(filePath);
  } catch (_error) {
    if (decodedPath === "/app" || decodedPath.startsWith("/app/") || decodedPath === "/w" || decodedPath.startsWith("/w/")) {
      filePath = path.join(distDir, "index.html");
      stat = statSync(filePath);
    } else {
      return null;
    }
  }
  if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
  return filePath;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`cosheaf server listening on http://localhost:${info.port}`);
  console.log(`forgejo: ${config.forgejoUrl} (owner=${config.forgejoOwner})`);
  console.log(`data dir: ${config.dataDir}`);
});
