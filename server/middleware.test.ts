// Tests for the workspace permission middleware: Forgejo-derived role
// resolution, in-process cache, none → 404, and the cache-bypassing
// admin-fresh middleware.

import { createHash } from "node:crypto";
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
import { _resetPermCacheForTests, requireAdminFresh, requireAuth, requireMembership } from "./middleware.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-middleware-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-middleware-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function seedUser(db: Database.Database, username: string): string {
  const token = `cs_${username}`;
  db.prepare(
    "INSERT INTO users (username, password_hash, forgejo_username, created_at) VALUES (?, 'hash', ?, 0)",
  ).run(username, `cs-${username}`);
  const userId = (db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: number }).id;
  db.prepare("INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, 'test', ?, 0)").run(
    userId,
    sha256Hex(token),
  );
  return token;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("forgejo", new Forgejo({ baseUrl: config.forgejoUrl, adminToken: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.use("/w/*", requireAuth);
  app.use("/w/:slug/*", requireMembership());
  app.get("/w/:slug/probe", (c) => c.json({ ok: true, role: c.get("workspace").role }));
  app.post("/w/:slug/admin-only", requireAdminFresh, (c) => c.json({ ok: true }));
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
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
  it("resolves Forgejo collaborator permission and sets ws.role", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValueOnce(ok({ permission: "write" }));

    const res = await appFor(db).request("/w/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "write" });
  });

  it("returns 404 (not 403) when Forgejo says the user has no collaborator access", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    // Forgejo returns 404 from the permission endpoint for an unknown
    // collaborator → translated to role 'none' → middleware hides the workspace.
    fetchMock.mockResolvedValueOnce(notFound());

    const res = await appFor(db).request("/w/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("treats Forgejo's owner permission as admin", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValueOnce(ok({ permission: "owner" }));

    const res = await appFor(db).request("/w/w/probe", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "admin" });
  });

  it("caches by (owner, repo, user) — back-to-back requests hit Forgejo once", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock.mockResolvedValue(ok({ permission: "write" }));

    const app = appFor(db);
    await app.request("/w/w/probe", { headers: { authorization: `Bearer ${token}` } });
    await app.request("/w/w/probe", { headers: { authorization: `Bearer ${token}` } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not collide across workspaces with the same user", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w1', 'W1', 'repo1', 0)",
    ).run();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (2, 'w2', 'W2', 'repo2', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "write" })) // w1
      .mockResolvedValueOnce(ok({ permission: "read" })); // w2

    const app = appFor(db);
    const r1 = await app.request("/w/w1/probe", { headers: { authorization: `Bearer ${token}` } });
    const r2 = await app.request("/w/w2/probe", { headers: { authorization: `Bearer ${token}` } });
    expect(await r1.json()).toEqual({ ok: true, role: "write" });
    expect(await r2.json()).toEqual({ ok: true, role: "read" });
  });
});

describe("requireAdminFresh", () => {
  it("re-fetches Forgejo permission, ignoring the cached role", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "admin" })) // requireMembership caches admin
      .mockResolvedValueOnce(ok({ permission: "write" })); // requireAdminFresh sees the demotion

    const res = await appFor(db).request("/w/w/admin-only", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("allows the request when Forgejo still reports admin", async () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
    ).run();
    const token = seedUser(db, "alice");
    fetchMock
      .mockResolvedValueOnce(ok({ permission: "admin" }))
      .mockResolvedValueOnce(ok({ permission: "admin" }));

    const res = await appFor(db).request("/w/w/admin-only", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
