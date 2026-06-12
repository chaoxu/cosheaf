import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { notifications } from "./notifications.js";
import { freshTestDb, responseEmpty as empty, responseOk as ok, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("notifications");

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-notifs-");
  seedTestWorkspace(db);
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/api/v1/w", notifications));
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
    expect(url.pathname).toBe("/api/v1/repos/owner/w/notifications");
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
            url: "http://forgejo.test/api/v1/repos/owner/w/issues/42",
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
            url: "http://forgejo.test/api/v1/repos/owner/w/pulls/9",
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
    fetchMock
      .mockResolvedValueOnce(ok({
        id: 101,
        unread: true,
        pinned: false,
        updated_at: "2026-05-17T10:00:00Z",
        url: "http://forgejo.test/api/v1/notifications/threads/101",
        subject: {
          type: "Issue",
          title: "Bug A",
          url: "http://forgejo.test/api/v1/repos/owner/w/issues/42",
          latest_comment_url: "",
        },
        repository: { full_name: "owner/w", name: "w" },
      }))
      .mockResolvedValueOnce(empty(204));
    const res = await appFor(db).request("/api/v1/w/w/notifications/101/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/notifications/threads/101");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/v1/notifications/threads/101");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
  });

  it("does not mark a notification thread from another repo as read", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok({
      id: 101,
      unread: true,
      pinned: false,
      updated_at: "2026-05-17T10:00:00Z",
      url: "http://forgejo.test/api/v1/notifications/threads/101",
      subject: {
        type: "Issue",
        title: "Bug A",
        url: "http://forgejo.test/api/v1/repos/owner/other/issues/42",
        latest_comment_url: "",
      },
      repository: { full_name: "owner/other", name: "other" },
    }));

    const res = await appFor(db).request("/api/v1/w/w/notifications/101/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-integer notification ids before calling Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await appFor(db).request("/api/v1/w/w/notifications/1.5/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad id", code: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(url.pathname).toBe("/api/v1/repos/owner/w/notifications");
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
