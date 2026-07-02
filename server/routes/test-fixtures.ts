// Shared boilerplate for route-level tests. The auth/membership helpers
// live alongside in server/test-helpers.ts; this module covers the db
// lifecycle + the small Response builders. Per-route tests still own
// their own `appFor()` (routers differ) and any Forgejo-payload fixtures
// that are route-specific.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { DEFAULT_DOCUMENT_FORMAT_ID } from "../../shared/document-format.js";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { makeT } from "../../shared/i18n/index.js";
import type { LocalGitWorkspaceBackend } from "../local/local-git-backend.js";
import { WorkspaceRegistry } from "../local/workspace-registry.js";
import { resolveLocale } from "../locale.js";
import { _seedFormatCacheForTests } from "../middleware.js";
import { SSEHub } from "../sse.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import type { WorkspaceBackend } from "../workspace-backend.js";

// Tracks every Database returned by freshTestDb() so a single afterEach
// closes them and cleans up the tmpdir behind them. Without this each
// test file leaked one tmpdir per freshDb() call.
const openDbs: Array<{ db: Database.Database; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of openDbs.splice(0)) {
    try { db.close(); } catch (_err) { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* already gone */ }
  }
});

const SCHEMA = readFileSync(path.join(import.meta.dirname, "..", "schema.sql"), "utf8");

// Build a fresh, isolated SQLite under a tmpdir. WAL + FK on. The caller
// seeds rows it needs; seedTestWorkspace() is the common one and lives
// alongside.
export function freshTestDb(prefix = "cosheaf-test-"): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = new Database(path.join(dir, "test.sqlite"));
  openDbs.push({ db, dir });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

interface WorkspaceSeed {
  owner?: string;
  repo?: string;
  default_md_format?: string;
}

// Register a test workspace with the middleware. The `workspaces` table is
// gone (#62); the only thing that needs setup now is the in-process format
// cache so requireMembership can resolve `defaultMdFormat` without an actual
// Forgejo round-trip. The default identity is owner "owner" / repo "w" so
// route tests hit /api/v1/repos/owner/w/... and the fake Forgejo upstream
// paths stay http://forgejo.test/api/v1/repos/owner/w/....
export function seedTestWorkspace(
  db: Database.Database,
  init: WorkspaceSeed = {},
): { owner: string; repo: string; slug: string } {
  const owner = init.owner ?? "owner";
  const repo = init.repo ?? "w";
  const formatId = init.default_md_format ?? DEFAULT_DOCUMENT_FORMAT_ID;
  _seedFormatCacheForTests(owner, repo, formatId);
  // `db` is intentionally unused: there is no SQLite row to seed anymore.
  // Kept in the signature so test callers don't need to change.
  void db;
  return { owner, repo, slug: workspaceSlug(owner, repo) };
}

// Canonical test Config. Every route test used to repeat this object with
// only dataDir varying; `name` keeps the per-suite tmp path distinct.
export function testConfig(name: string, overrides: Partial<Config> = {}): Config {
  return {
    mode: "hosted",
    dataDir: `/tmp/cosheaf-${name}-test`,
    port: 3030,
    host: "127.0.0.1",
    accessToken: null,
    forgejoUrl: "http://forgejo.test",
    forgejoToken: "admin-token",
    forgejoAdminToken: "admin-token",
    webhookSecret: "secret",
    webhookUrl: "http://cosheaf.test/webhook",
    publicOrigin: null,
    registrationOpen: false,
    trustedProxyHops: 0,
    coverifyCmd: "coverify",
    coverifyApiUrl: "http://cosheaf.test/api/v1",
    coverifyBotToken: "",
    coverifyBotLogin: "coverify",
    reconcileIntervalMs: 0,
    ...overrides,
  };
}

// Hono app with the standard request context (db/config/fjAdmin/sse) that
// every route suite used to wire up by hand. `mount` registers the routers
// under test; `fjAdmin` overrides the default admin client (webhook tests
// pass their own).
export function testApp(
  db: Database.Database,
  config: Config,
  mount: (app: Hono<AppEnv>) => void,
  fjAdmin?: Forgejo,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const sse = new SSEHub();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", fjAdmin ?? new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken }));
    c.set("sse", sse);
    const locale = resolveLocale(c);
    c.set("locale", locale);
    c.set("t", makeT(locale));
    await next();
  });
  mount(app);
  return app;
}

export function fakeWorkspaceBackend(overrides: Partial<WorkspaceBackend> = {}): WorkspaceBackend {
  function missing<K extends keyof WorkspaceBackend>(name: K): WorkspaceBackend[K] {
    return (async () => {
      throw new Error(`fake WorkspaceBackend method not implemented: ${String(name)}`);
    }) as WorkspaceBackend[K];
  }
  return {
    getTree: missing("getTree"),
    getRawFile: missing("getRawFile"),
    getRawFileBytes: missing("getRawFileBytes"),
    getFileMeta: missing("getFileMeta"),
    putFile: missing("putFile"),
    putFileBytes: missing("putFileBytes"),
    deleteFile: missing("deleteFile"),
    getBranch: missing("getBranch"),
    listBranches: missing("listBranches"),
    createBranch: missing("createBranch"),
    deleteBranch: missing("deleteBranch"),
    getRepo: missing("getRepo"),
    listPulls: missing("listPulls"),
    getCommit: missing("getCommit"),
    ...overrides,
  };
}

export function testLocalRouteApp(
  db: Database.Database,
  config: Config,
  backend: WorkspaceBackend,
  mount: (app: Hono<AppEnv>) => void,
  identity: Partial<LocalWorkspaceIdentity> = {},
): Hono<AppEnv> {
  const localConfig = { ...config, mode: "local" as const };
  const ws: LocalWorkspaceIdentity = {
    owner: identity.owner ?? "owner",
    repo: identity.repo ?? "w",
    defaultMdFormat: identity.defaultMdFormat ?? DEFAULT_DOCUMENT_FORMAT_ID,
    user: identity.user ?? "alice",
    title: identity.title ?? "w",
    canOpenPull: identity.canOpenPull ?? false,
    originId: identity.originId,
  };
  const registry = new WorkspaceRegistry(db, { user: ws.user });
  registry.register({
    slug: workspaceSlug(ws.owner, ws.repo),
    path: "",
    identity: ws,
    // Test-only seam injection: route tests only call WorkspaceBackend methods.
    // Real local Workbench entries still use LocalGitWorkspaceBackend because
    // local-only routes such as open-PR need git-specific methods.
    backend: backend as LocalGitWorkspaceBackend,
    remote: null,
    gitRemote: null,
  });
  const app = new Hono<AppEnv>();
  const sse = new SSEHub();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", localConfig);
    c.set("localRegistry", registry);
    c.set("sse", sse);
    const locale = resolveLocale(c);
    c.set("locale", locale);
    c.set("t", makeT(locale));
    await next();
  });
  mount(app);
  return app;
}

export function testLocalRegistry(
  db: Database.Database,
  backend: LocalGitWorkspaceBackend,
  identity: LocalWorkspaceIdentity,
  path = "",
): WorkspaceRegistry {
  const registry = new WorkspaceRegistry(db, { user: identity.user });
  registry.register({
    slug: workspaceSlug(identity.owner, identity.repo),
    path,
    identity,
    backend,
    remote: null,
    gitRemote: null,
  });
  return registry;
}

// Declarative fake Forgejo backend for fetch stubbing. Register Hono routes
// matching Forgejo REST paths, then hand the returned function to
// `fetchMock.mockImplementation(...)`. Path params, methods, and bodies come
// from Hono instead of url.includes() substring matching; an unregistered
// request comes back as a 599 whose body names the method and path, so the
// resulting ForgejoError points straight at the missing stub.
export function fakeForgejo(
  register: (forge: Hono) => void,
): (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> {
  const forge = new Hono();
  register(forge);
  forge.notFound((c) => c.text(`no fake forgejo handler for ${c.req.method} ${c.req.path}`, 599 as 200));
  return async (input, init) => forge.request(input instanceof Request ? input : String(input), init);
}

// JSON Response builder for fetchMock. Default status is 200; the
// existing webhook/auth tests pass an explicit 201 etc. when they need
// it. Headers may carry e.g. content-type overrides for raw-file mocks.
export function responseOk(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Empty-body Response at the given status. A null body is valid for every
// status, including the no-body ones (204/304).
export function responseEmpty(status = 200): Response {
  return new Response(null, { status });
}
