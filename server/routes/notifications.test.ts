import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";
import { globalNotifications, notifications } from "./notifications.js";
import { responseEmpty as empty, freshTestDb, responseOk as ok, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("notifications");

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-notifs-");
  seedTestWorkspace(db);
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = testApp(db, config, (hono) => {
    hono.route("/api/v1", globalNotifications);
    hono.route("/api/v1/repos", notifications);
  });
  app.onError(handleAppError);
  return app;
}


const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications route", () => {
  it("pushes unread issue/pull filtering into Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repos/owner/w/notifications");
    expect(url.searchParams.get("status-types")).toBe("unread");
    expect(url.searchParams.get("subject-type")).toBe("Issue,Pull");
  });

  it("does not hide global notification list failures as an empty inbox", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(new Response("forgejo down", { status: 503 }));

    const res = await appFor(db).request("/api/v1/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: "bad_gateway" });
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
    const res = await appFor(db).request("/api/v1/repos/owner/w/notifications", {
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
    const res = await appFor(db).request("/api/v1/repos/owner/w/notifications/101/read", {
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
    // Two foreign threads: a different repo under the same owner, and the
    // SAME repo name under a different owner. Workspace identity is the
    // full (owner, repo) pair, so both must 404.
    const foreign = [
      { fullName: "owner/other", name: "other" },
      { fullName: "intruder/w", name: "w" },
    ];
    for (const { fullName, name } of foreign) {
      fetchMock.mockResolvedValueOnce(ok({
        id: 101,
        unread: true,
        pinned: false,
        updated_at: "2026-05-17T10:00:00Z",
        url: "http://forgejo.test/api/v1/notifications/threads/101",
        subject: {
          type: "Issue",
          title: "Bug A",
          url: `http://forgejo.test/api/v1/repos/${fullName}/issues/42`,
          latest_comment_url: "",
        },
        repository: { full_name: fullName, name },
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/notifications/101/read", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status, `expected 404 for thread from ${fullName}`).toBe(404);
    }
    // One GET per attempt, never the PATCH that would mark it read.
    expect(fetchMock).toHaveBeenCalledTimes(foreign.length);
  });

  it("rejects malformed notification ids before calling Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    for (const id of ["1.5", "1e2"]) {
      const res = await appFor(db).request(`/api/v1/repos/owner/w/notifications/${id}/read`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status, `expected ${id} to be rejected`).toBe(400);
      expect(await res.json()).toEqual({ error: "bad id", code: "validation" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mark-all marks every thread in the workspace's repo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));
    const res = await appFor(db).request("/api/v1/repos/owner/w/notifications/read-all", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repos/owner/w/notifications");
    expect(url.searchParams.get("status-types")).toBe("unread");
    expect(url.searchParams.get("to-status")).toBe("read");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("returns a single notification thread by global id (Issue/Pull only)", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(
      ok({
        id: 101,
        subject: {
          type: "Issue",
          title: "Bug A",
          url: "http://forgejo.test/api/v1/repos/owner/w/issues/42",
          html_url: "http://forgejo.test/owner/w/issues/42",
        },
        repository: { full_name: "owner/w" },
        updated_at: "2026-05-17T10:00:00Z",
      }),
    );
    const res = await appFor(db).request("/api/v1/notifications/threads/101", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/notifications/threads/101");
    const body = (await res.json()) as { notification: { id: number; kind: string; number: number; repo: string } };
    expect(body.notification).toMatchObject({ id: 101, kind: "issue", number: 42, repo: "owner/w" });
  });

  it("404s a single-thread fetch when the subject is not an Issue/Pull", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(
      ok({
        id: 103,
        subject: { type: "Commit", title: "fix", url: "...", html_url: "..." },
        repository: { full_name: "owner/w" },
        updated_at: "2026-05-17T12:00:00Z",
      }),
    );
    const res = await appFor(db).request("/api/v1/notifications/threads/103", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("marks one thread read by global id via the forge per-thread PATCH", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));
    const res = await appFor(db).request("/api/v1/notifications/101/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/notifications/threads/101");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
  });

  it("does not write to any SQLite tables for notifications (Forgejo is SoT)", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([]));
    await appFor(db).request("/api/v1/repos/owner/w/notifications", {
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
