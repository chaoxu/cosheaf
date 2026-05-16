import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { _seedPermCacheForTests } from "../middleware.js";
import { forgejoPassthrough } from "./forgejo-passthrough.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-passthrough-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-passthrough-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  return db;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function seedUser(db: Database.Database, id: number, username: string, role: Role): string {
  const token = `cs_${username}`;
  db.prepare(
    "INSERT INTO users (id, username, password_hash, forgejo_username, created_at) VALUES (?, ?, 'hash', ?, 0)",
  ).run(id, username, `cs-${username}`);
  db.prepare("INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, 'test', ?, 0)").run(
    id,
    sha256Hex(token),
  );
  // Skip the requireMembership Forgejo call by pre-populating its cache so the
  // fetchMock can be asserted purely against the request under test.
  // seedWorkspace uses repo='repo', forgejoOwner='owner'.
  _seedPermCacheForTests("owner", "repo", `cs-${username}`, role);
  return token;
}

function seedWorkspace(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
  ).run();
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    // Real Forgejo client; we mock global fetch instead so we exercise the
    // passthrough wiring end-to-end.
    c.set("forgejo", new Forgejo({ baseUrl: config.forgejoUrl, adminToken: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", forgejoPassthrough);
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Forgejo passthrough", () => {
  it("GET /forgejo/pulls proxies to /repos/{owner}/{repo}/pulls and returns body verbatim", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([{ number: 7 }], { link: "<next>; rel=\"next\"" }));

    const res = await appFor(db).request("/api/v1/w/w/forgejo/pulls?state=open", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ number: 7 }]);
    expect(res.headers.get("link")).toBe('<next>; rel="next"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/repos/owner/repo/pulls?state=open");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("token admin-token");
    expect(headers.sudo).toBe("cs-alice");
  });

  it("POST /forgejo/issues forwards body verbatim and returns Forgejo's response", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 42, title: "hi" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await appFor(db).request("/api/v1/w/w/forgejo/issues", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "hi", body: "world" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ number: 42, title: "hi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/repos/owner/repo/issues");
    expect(init.method).toBe("POST");
    const body = init.body as ArrayBuffer;
    expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ title: "hi", body: "world" }));
  });

  it("rejects admin paths with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const res = await appFor(db).request("/api/v1/w/w/forgejo/admin/users", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "passthrough path not allowed", code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects traversal segments with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    // Hono normalizes ../ in the URL — exercise the explicit `..` segment.
    const res = await appFor(db).request("/api/v1/w/w/forgejo/pulls/..", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown prefixes with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const res = await appFor(db).request("/api/v1/w/w/forgejo/unknown-thing", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes an audit log entry per call", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([]));
    fetchMock.mockResolvedValueOnce(ok({ number: 3 }, { "content-type": "application/json" }));

    const app = appFor(db);
    await app.request("/api/v1/w/w/forgejo/pulls?state=open", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/w/w/forgejo/issues/3", {
      headers: { authorization: `Bearer ${token}` },
    });
    // 403 should also log? Spec says "log every passthrough call". The
    // forbidden response never went to Forgejo; we only log forwarded ones.
    await app.request("/api/v1/w/w/forgejo/admin/users", {
      headers: { authorization: `Bearer ${token}` },
    });

    const rows = db
      .prepare(
        "SELECT method, path, query, status FROM forgejo_passthrough_log ORDER BY id ASC",
      )
      .all() as Array<{ method: string; path: string; query: string | null; status: number }>;
    expect(rows).toEqual([
      { method: "GET", path: "pulls", query: "state=open", status: 200 },
      { method: "GET", path: "issues/3", query: null, status: 200 },
    ]);
  });

  it("non-owner member can hit /forgejo/issues (Sudo carries their identity)", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const memberToken = seedUser(db, 1, "bob", "write");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await appFor(db).request("/api/v1/w/w/forgejo/issues", {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "from-member" }),
    });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.sudo).toBe("cs-bob");
  });
});
