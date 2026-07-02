import { createWriteStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { makeT } from "../shared/i18n/index.js";
import { rejectCrossOriginCookieApiMutation } from "./api-csrf.js";
import { resolveAppRoot, resolveCoflatDistDir } from "./app-root.js";
import { contentTypeForPath } from "./content-type.js";
import type { Config } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { healthPayload, healthStatus } from "./health.js";
import { localAuthGate } from "./local/local-auth.js";
import { localAnnotations } from "./local/local-annotations.js";
import { localNotifications } from "./local/local-notifications.js";
import { localPulls } from "./local/local-pulls.js";
import { createLocalWebRouter } from "./local/local-web.js";
import { WorkspaceRegistry } from "./local/workspace-registry.js";
import { resolveLocale } from "./locale.js";
import { auth } from "./routes/auth.js";
import { branches } from "./routes/branches.js";
import { handleAppError } from "./routes/error-handler.js";
import { files } from "./routes/files.js";
import { issues } from "./routes/issues.js";
import { globalNotifications, notifications } from "./routes/notifications.js";
import { origin } from "./routes/origin.js";
import { pulls } from "./routes/pulls.js";
import { web } from "./routes/web.js";
import { webhooks } from "./routes/webhooks.js";
import { members, workspaces } from "./routes/workspaces.js";
import { SSEHub } from "./sse.js";
import { listPublicAssetPaths } from "./static-assets.js";
import type { AppEnv } from "./types.js";
import { viteDevOrigin } from "./vite-dev-origin.js";

export interface CreateAppOptions {
  config: Config;
  db: Database.Database;
  fjAdmin?: Forgejo;
  sse?: SSEHub;
  // Local Workbench (config.mode === "local"): the registry of opened folders.
  localRegistry?: WorkspaceRegistry;
}

export type AppContentProvider = "forgejo" | "local-git";
export type AppCollaborationProvider = "self" | "federated";

export interface AppProviderCapabilities {
  content: AppContentProvider;
  collaboration: AppCollaborationProvider;
  mountsLocalWorkbench: boolean;
  mountsHostedAuth: boolean;
  mountsHostedCollaboration: boolean;
}

export function appProviderCapabilities(config: Pick<Config, "mode">): AppProviderCapabilities {
  if (config.mode === "local") {
    return {
      content: "local-git",
      collaboration: "federated",
      mountsLocalWorkbench: true,
      mountsHostedAuth: false,
      mountsHostedCollaboration: false,
    };
  }
  return {
    content: "forgejo",
    collaboration: "self",
    mountsLocalWorkbench: false,
    mountsHostedAuth: true,
    mountsHostedCollaboration: true,
  };
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { config, db } = options;
  const provider = appProviderCapabilities(config);
  const local = provider.mountsLocalWorkbench;
  // No admin forge client in local mode — webhooks/provisioning aren't mounted
  // and the Workbench is Forgejo-free.
  const fjAdmin = provider.mountsHostedCollaboration
    ? options.fjAdmin ?? new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken })
    : undefined;
  const sse = options.sse ?? new SSEHub();

  const registry = options.localRegistry ?? (local ? new WorkspaceRegistry(db) : undefined);

  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  if (provider.mountsLocalWorkbench) {
    // The single-user Workbench writes a timestamped request+timing line to
    // <dataDir>/server.log (appended) so it can always be inspected after the
    // fact: slow requests show a high duration, and errors still get a line.
    const logStream = createWriteStream(path.join(config.dataDir, "server.log"), { flags: "a" });
    app.use("*", async (c, next) => {
      const start = Date.now();
      try {
        await next();
      } finally {
        logStream.write(`${new Date().toISOString()} ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms\n`);
      }
    });
  } else if (process.env.COSHEAF_REQUEST_LOG) {
    app.use("*", logger());
  }
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    if (fjAdmin) c.set("fjAdmin", fjAdmin);
    if (provider.mountsLocalWorkbench && registry) c.set("localRegistry", registry);
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
  app.route("/api/v1", origin);

  if (provider.mountsLocalWorkbench) {
    // No notifications in local mode, so neuter the chrome's notification poller:
    // serve an empty cosheaf-notifications.js (registered before the static asset
    // routes, so it wins). That stops the per-page EventSource to
    // /api/v1/notifications/events — a long-lived SSE that pins an HTTP/1.1
    // connection; with several tabs/navigations open they saturate the browser's
    // ~6-connection-per-origin pool and the next request "loads forever".
    app.get("/cosheaf-notifications.js", (c) =>
      c.body("", 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" }),
    );
    // Access gate: a no-op unless COSHEAF_WORKBENCH_TOKEN is set. When set, the
    // typed API the islands/agents call requires the token (Bearer or cookie),
    // mirroring the web router's gate. Mounted after the CSRF guard above and
    // before the local API routes; /api/v1/health and /api/v1/origin are mounted
    // earlier and stay reachable for liveness/discovery.
    app.use("/api/v1/*", localAuthGate());
    // Local Workbench: the forge-free, backend-driven content routes the page
    // islands call, plus the shared collaboration API reading the connected core
    // via ctx.collab (#268). localPulls is mounted before the typed pulls router
    // so its POST /pulls (local commit + push + open PR on the connected core)
    // wins over the typed create-PR handler; the typed router serves the GET
    // reads. localNotifications keeps the chrome's global poller + SSE silent.
    app.route("/api/v1/repos", localAnnotations);
    app.route("/api/v1/repos", files);
    app.route("/api/v1/repos", branches);
    app.route("/api/v1/repos", localPulls);
    app.route("/api/v1/repos", pulls);
    app.route("/api/v1/repos", issues);
    app.route("/api/v1/repos", notifications);
    app.route("/api/v1", localNotifications);
    // The local Workbench does not mount the global notification mark-read
    // routes (`/api/v1/notifications/read-all`, `/api/v1/notifications/:id/read`)
    // — nothing in local calls them. But the web router is the "/" catch-all, so
    // an unmatched /api/v1/* would otherwise fall through to its HTML 404 page.
    // Answer the typed JSON envelope here instead so API callers get a parseable
    // 404, not chrome HTML.
    app.all("/api/v1/*", (c) => c.json({ error: "not found" }, 404));
  } else if (provider.mountsHostedAuth && provider.mountsHostedCollaboration) {
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

  const appRoot = resolveAppRoot();
  const distDir = path.resolve(appRoot, "dist");
  const publicDir = path.resolve(appRoot, "public");
  const publicAssetPaths = new Set(listPublicAssetPaths(publicDir, distDir));
  const coflatEditorDistDir = resolveCoflatDistDir(appRoot, () => requireResolve("@chaoxu/coflat/style.css"));

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

  app.route("/", local ? createLocalWebRouter() : web);

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
