import { Hono } from "hono";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypeForPath } from "./content-type.js";
import type { Config } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { healthPayload, healthStatus } from "./health.js";
import { resolveLocale } from "./locale.js";
import { rejectCrossOriginCookieApiMutation } from "./api-csrf.js";
import { auth } from "./routes/auth.js";
import { branches } from "./routes/branches.js";
import { files } from "./routes/files.js";
import { handleAppError } from "./routes/error-handler.js";
import { issues } from "./routes/issues.js";
import { globalNotifications, notifications } from "./routes/notifications.js";
import { pulls } from "./routes/pulls.js";
import { web } from "./routes/web.js";
import { webhooks } from "./routes/webhooks.js";
import { members, workspaces } from "./routes/workspaces.js";
import { SSEHub } from "./sse.js";
import { listPublicAssetPaths } from "./static-assets.js";
import { createLocalWebRouter } from "./local/local-web.js";
import type { AppEnv, LocalWorkspaceIdentity } from "./types.js";
import type { WorkspaceBackend } from "./workspace-backend.js";
import { viteDevOrigin } from "./vite-dev-origin.js";
import { makeT } from "../shared/i18n/index.js";

import type Database from "better-sqlite3";

export interface CreateAppOptions {
  config: Config;
  db: Database.Database;
  fjAdmin?: Forgejo;
  sse?: SSEHub;
  // Local Workbench (config.mode === "local"): the single on-disk backend and
  // the workspace identity it serves. Required in local mode; ignored otherwise.
  workspaceBackend?: WorkspaceBackend;
  localWorkspace?: LocalWorkspaceIdentity;
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { config, db } = options;
  const local = config.mode === "local";
  // No admin forge client in local mode — webhooks/provisioning aren't mounted
  // and the Workbench is Forgejo-free.
  const fjAdmin = local ? undefined : options.fjAdmin ?? new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken });
  const sse = options.sse ?? new SSEHub();
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  if (process.env.COSHEAF_REQUEST_LOG) app.use("*", logger());
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    if (fjAdmin) c.set("fjAdmin", fjAdmin);
    if (local && options.workspaceBackend && options.localWorkspace) {
      c.set("localBackend", options.workspaceBackend);
      c.set("localWorkspace", options.localWorkspace);
    }
    c.set("sse", sse);
    const locale = resolveLocale(c);
    c.set("locale", locale);
    c.set("t", makeT(locale));
    await next();
  });

  app.get("/api/v1/health", (c) => {
    const payload = healthPayload(db);
    return c.json(payload, healthStatus(payload));
  });

  app.onError(handleAppError);

  app.use("/api/v1/*", rejectCrossOriginCookieApiMutation);

  if (local) {
    // Local Workbench: only the Forgejo-free, backend-driven typed routes the
    // page islands call. No auth/workspaces/pulls/issues/notifications/webhooks.
    app.route("/api/v1/repos", files);
    app.route("/api/v1/repos", branches);
  } else {
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
  }

  const distDir = path.resolve(process.cwd(), "dist");
  const publicDir = path.resolve(process.cwd(), "public");
  const publicAssetPaths = new Set(listPublicAssetPaths(publicDir, distDir));
  const coflatEditorDistDir = path.dirname(
    requireResolve("@chaoxu/coflat/style.css"),
  );

  if (process.env.NODE_ENV !== "production") {
    app.get("/node_modules/*", async (c) => {
      const response = await fetch(new URL(c.req.path, viteDevOrigin()));
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? contentTypeForPath(c.req.path) },
      });
    });
    app.get("/@fs/*", async (c) => {
      const response = await fetch(new URL(c.req.path, viteDevOrigin()));
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
    const response = await serveCoflatEditorAsset(c.req.path, coflatEditorDistDir);
    return response ?? c.json({ error: "not found" }, 404);
  });

  for (const assetPath of publicAssetPaths) {
    app.get(assetPath, async (c) => {
      const response = await servePublicOrDistFile(c.req.path, publicDir, distDir);
      return response ?? c.json({ error: "not found" }, 404);
    });
  }

  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 302));

  app.get("/assets/*", async (c) => {
    const response = await serveDistFile(c.req.path, distDir);
    return response ?? c.json({ error: "not found" }, 404);
  });

  app.get("/fonts/*", async (c) => {
    const response = await servePublicOrDistFile(c.req.path, publicDir, distDir);
    return response ?? c.json({ error: "not found" }, 404);
  });

  app.route(
    "/",
    local && options.localWorkspace
      ? createLocalWebRouter(options.localWorkspace.owner, options.localWorkspace.repo)
      : web,
  );

  return app;
}

async function serveDistFile(requestPath: string, distDir: string): Promise<Response | null> {
  const resolvedPath = resolveDistPath(requestPath, distDir);
  if (!resolvedPath) return null;
  const body = await readFile(resolvedPath);
  return new Response(body, { headers: staticFileHeaders(resolvedPath, cacheControlForRequestPath(requestPath)) });
}

async function servePublicOrDistFile(requestPath: string, publicDir: string, distDir: string): Promise<Response | null> {
  const publicPath = resolveStaticPath(publicDir, requestPath);
  if (publicPath) {
    const body = await readFile(publicPath);
    return new Response(body, { headers: staticFileHeaders(publicPath, "public, max-age=60") });
  }
  return serveDistFile(requestPath, distDir);
}

async function serveCoflatEditorAsset(requestPath: string, coflatEditorDistDir: string): Promise<Response | null> {
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

function resolveDistPath(requestPath: string, distDir: string): string | null {
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
