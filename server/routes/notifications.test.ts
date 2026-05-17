import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { SSEHub } from "../sse.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { notifications } from "./notifications.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-notifications-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-notifs-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
  ).run();
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", notifications);
  return app;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function empty(status: number): Response {
  // Some HTTP statuses (204, 205, 304) forbid a body; Response throws on
  // them with a non-empty body. We construct with an empty body but the
  // current spec says even an empty string can be invalid for 204/205.
  // Use 200 with no body for mocks that don't care about the exact code.
  return new Response(null, { status: status === 204 || status === 205 ? 200 : status });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
  _resetBearerAuthCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications route", () => {
  it("pushes unread issue/pull filtering into Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request("/api/v1/w/w/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repos/owner/repo/notifications");
    expect(url.searchParams.get("status-types")).toBe("unread");
    expect(url.searchParams.get("subject-type")).toBe("Issue,Pull");
  });

  it("normalizes Forgejo threads into NotificationRow shape", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(
      ok([
        {
          id: 101,
          subject: {
            type: "Issue",
            title: "Bug A",
            url: "http://forgejo.test/api/v1/repos/owner/repo/issues/42",
            html_url: "http://forgejo.test/owner/repo/issues/42",
          },
          repository: { full_name: "owner/repo" },
          updated_at: "2026-05-17T10:00:00Z",
        },
        {
          id: 102,
          subject: {
            type: "Pull",
            title: "PR B",
            url: "http://forgejo.test/api/v1/repos/owner/repo/pulls/9",
            html_url: "http://forgejo.test/owner/repo/pulls/9",
          },
          repository: { full_name: "owner/repo" },
          updated_at: "2026-05-17T11:00:00Z",
        },
        // Non-issue/non-PR thread is dropped.
        {
          id: 103,
          subject: { type: "Commit", title: "fix", url: "...", html_url: "..." },
          repository: { full_name: "owner/repo" },
          updated_at: "2026-05-17T12:00:00Z",
        },
      ]),
    );
    const res = await appFor(db).request("/api/v1/w/w/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<{ id: number; kind: string; number: number }> };
    // Sorted by updated_at desc; commit dropped.
    expect(body.notifications.map((n) => ({ id: n.id, kind: n.kind, number: n.number }))).toEqual([
      { id: 102, kind: "pr", number: 9 },
      { id: 101, kind: "issue", number: 42 },
    ]);
  });

  it("mark-read calls Forgejo PATCH for the thread", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));
    const res = await appFor(db).request("/api/v1/w/w/notifications/101/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/notifications/threads/101");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
  });

  it("mark-all marks every thread in the workspace's repo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));
    const res = await appFor(db).request("/api/v1/w/w/notifications/read-all", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repos/owner/repo/notifications");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("does not write to any SQLite tables for notifications (Forgejo is SoT)", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([]));
    await appFor(db).request("/api/v1/w/w/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });
    // Sanity: there is no `notifications` table in the schema. If a future
    // change adds durable mirroring, this assertion catches it.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("notifications");
    expect(tables.map((t) => t.name)).not.toContain("notification_threads");
  });
});
