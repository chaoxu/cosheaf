// Tests for the workspace permission middleware: Forgejo-derived role
// resolution, in-process cache, none → 404, and the cache-bypassing
// admin-fresh middleware.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./db.js";
import { Forgejo } from "./forgejo.js";
import { SSEHub } from "./sse.js";
import type { AppEnv } from "./types.js";
import { _resetBearerAuthCacheForTests, _resetFormatCacheForTests, _resetPermCacheForTests, _seedFormatCacheForTests, requireAdminFresh, requireAuth, requireMembership } from "./middleware.js";
import { seedAuthUser } from "./test-helpers.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-middleware-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoAdminToken: "admin-token",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  registrationOpen: false,
  trustedProxyHops: 0,
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-middleware-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

function seedUser(db: Database.Database, username: string): string {
  return seedAuthUser(db, config, { username });
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.use("/repos/*", requireAuth);
  app.use("/repos/:owner/:repo/*", requireMembership());
  app.get("/repos/:owner/:repo/probe", (c) => c.json({ ok: true, role: c.get("workspace").role }));
  app.post("/repos/:owner/:repo/admin-only", requireAdminFresh, (c) => c.json({ ok: true }));
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
  _resetBearerAuthCacheForTests();
  _resetFormatCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

describe("requireMembership", () => {
  it("accepts a Forgejo PAT bearer by resolving /api/v1/user", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    fetchMock
      .mockResolvedValueOnce(ok({ login: "alice" }))
      .mockResolvedValueOnce(ok({ permission: "write" }));

    const res = await appFor(db).request("/repos/owner/w/probe", {
      headers: { authorization: "Bearer forgejo-pat-alice" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "write" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/user");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      authorization: "token forgejo-pat-alice",
    });
  });

  it("resolves Forgejo collaborator permission and sets ws.role", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValueOnce(ok({ permission: "write" }));

    const res = await appFor(db).request("/repos/owner/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "write" });
  });

  it("returns 404 (not 403) when Forgejo says the user has no collaborator access", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    // Forgejo returns 404 from the permission endpoint for an unknown
    // collaborator → translated to role 'none' → middleware hides the workspace.
    fetchMock.mockResolvedValueOnce(notFound());

    const res = await appFor(db).request("/repos/owner/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("treats Forgejo's owner permission as admin", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValueOnce(ok({ permission: "owner" }));

    const res = await appFor(db).request("/repos/owner/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "admin" });
  });

  it("caches by (owner, repo, user) — back-to-back requests hit Forgejo once", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValue(ok({ permission: "write" }));

    const app = appFor(db);
    await app.request("/repos/owner/w/probe", { headers: { authorization: `Bearer ${token}` } });
    await app.request("/repos/owner/w/probe", { headers: { authorization: `Bearer ${token}` } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not collide across workspaces with the same user", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w1", "forgejo-passthrough");
    _seedFormatCacheForTests("owner", "w2", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "write" })) // w1
      .mockResolvedValueOnce(ok({ permission: "read" })); // w2

    const app = appFor(db);
    const r1 = await app.request("/repos/owner/w1/probe", { headers: { authorization: `Bearer ${token}` } });
    const r2 = await app.request("/repos/owner/w2/probe", { headers: { authorization: `Bearer ${token}` } });
    expect(await r1.json()).toEqual({ ok: true, role: "write" });
    expect(await r2.json()).toEqual({ ok: true, role: "read" });
  });

  it("does not collide across owners with the same repo name", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("alice-org", "w1", "forgejo-passthrough");
    _seedFormatCacheForTests("bob-org", "w1", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "admin" })) // alice-org/w1
      .mockResolvedValueOnce(notFound()); // bob-org/w1 — no access

    const app = appFor(db);
    const r1 = await app.request("/repos/alice-org/w1/probe", { headers: { authorization: `Bearer ${token}` } });
    const r2 = await app.request("/repos/bob-org/w1/probe", { headers: { authorization: `Bearer ${token}` } });
    expect(await r1.json()).toEqual({ ok: true, role: "admin" });
    expect(r2.status).toBe(404);
  });
});

describe("requireAdminFresh", () => {
  it("re-fetches Forgejo permission, ignoring the cached role", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "admin" })) // requireMembership caches admin
      .mockResolvedValueOnce(ok({ permission: "write" })); // requireAdminFresh sees the demotion

    const res = await appFor(db).request("/repos/owner/w/admin-only", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("allows the request when Forgejo still reports admin", async () => {
    const db = freshDb();
    _seedFormatCacheForTests("owner", "w", "forgejo-passthrough");
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "admin" }))
      .mockResolvedValueOnce(ok({ permission: "admin" }));

    const res = await appFor(db).request("/repos/owner/w/admin-only", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
