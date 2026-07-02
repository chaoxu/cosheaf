import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerNotificationActivityRoutes } from "./web-activity.js";

const config = testConfig("web-activity");

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = testApp(db, config, (hono) => registerNotificationActivityRoutes(hono));
  app.onError(handleAppError);
  return app;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
});

afterEach(() => vi.unstubAllGlobals());

describe("web activity routes", () => {
  it("marks only notification threads that belong to the current repository", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    let marked = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/notifications/threads/101", () =>
          Response.json({
            id: 101,
            repository: { full_name: "owner/w" },
            subject: { type: "Issue", title: "Bug", url: "http://forgejo.test/api/v1/repos/owner/w/issues/7" },
            updated_at: "2026-06-01T00:00:00Z",
          }),
        );
        forge.patch("/api/v1/notifications/threads/101", () => {
          marked = true;
          return new Response(null, { status: 204 });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/notifications/101/read", {
      method: "POST",
      headers: { cookie: `cosheaf_pat=${token}`, origin: "http://localhost" },
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/notifications");
    expect(marked).toBe(true);
  });

  it("does not mark stale or foreign notification threads as read", async () => {
    const cases = [
      { label: "stale", thread: null },
      { label: "same repo name under another owner", thread: { repository: { full_name: "intruder/w" } } },
      { label: "different repo under same owner", thread: { repository: { full_name: "owner/other" } } },
    ];

    for (const testCase of cases) {
      const db = freshTestDb("cosheaf-web-activity-");
      seedTestWorkspace(db);
      const token = seedAuthUser(db, config, { username: "alice", role: "read" });
      let marked = false;
      fetchMock.mockReset();
      fetchMock.mockImplementation(
        fakeForgejo((forge) => {
          forge.get("/api/v1/notifications/threads/101", () =>
            testCase.thread
              ? Response.json({
                  id: 101,
                  repository: testCase.thread.repository,
                  subject: { type: "Issue", title: "Bug", url: "http://forgejo.test/api/v1/repos/owner/w/issues/7" },
                  updated_at: "2026-06-01T00:00:00Z",
                })
              : new Response("not found", { status: 404 }),
          );
          forge.patch("/api/v1/notifications/threads/101", () => {
            marked = true;
            return new Response(null, { status: 204 });
          });
        }),
      );

      const res = await appFor(db).request("/owner/w/notifications/101/read", {
        method: "POST",
        headers: { cookie: `cosheaf_pat=${token}`, origin: "http://localhost" },
      });

      expect(res.status, testCase.label).toBe(404);
      expect(await res.text()).toContain("Notification not found");
      expect(marked, testCase.label).toBe(false);
    }
  });

  it("rejects malformed notification ids before contacting Forgejo", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });

    for (const id of ["1.5", "1e2"]) {
      const res = await appFor(db).request(`/owner/w/notifications/${id}/read`, {
        method: "POST",
        headers: { cookie: `cosheaf_pat=${token}`, origin: "http://localhost" },
      });

      expect(res.status, id).toBe(404);
    }
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("/notifications/threads/"))).toBe(true);
  });

  it("does not render an empty web notification inbox when Forgejo fails", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/notifications", () => new Response("forgejo down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/owner/w/notifications", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain("No unread notifications");
  });

  it("does not coerce malformed activity issue or pull numbers into links", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/activities/feeds", (c) =>
          c.json([
            {
              id: 1,
              op_type: "create_pull_request",
              act_user: { login: "alice" },
              content: JSON.stringify(["1e2", "Bad PR"]),
              created: "2026-06-01T00:00:00Z",
            },
            {
              id: 2,
              op_type: "create_issue",
              act_user: { login: "alice" },
              content: JSON.stringify(["7.0", "Bad issue"]),
              created: "2026-06-01T00:00:01Z",
            },
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/owner/w/activity", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("opened a pull request");
    expect(body).toContain("opened an issue");
    expect(body).not.toContain("/pulls/100");
    expect(body).not.toContain("/issues/7");
  });

  it("renders collapsed edit activity repeat counts", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/activities/feeds", (c) =>
          c.json([
            {
              id: 3,
              op_type: "commit_repo",
              act_user: { login: "alice" },
              ref_name: "refs/heads/user/alice/wip",
              content: JSON.stringify({ Commits: [{ Sha1: "cccc", Message: "update three.md" }] }),
              created: "2026-06-01T00:00:02Z",
            },
            {
              id: 2,
              op_type: "commit_repo",
              act_user: { login: "alice" },
              ref_name: "refs/heads/user/alice/wip",
              content: JSON.stringify({ Commits: [{ Sha1: "bbbb", Message: "update two.md" }] }),
              created: "2026-06-01T00:00:01Z",
            },
            {
              id: 1,
              op_type: "commit_repo",
              act_user: { login: "alice" },
              ref_name: "refs/heads/user/alice/wip",
              content: JSON.stringify({ Commits: [{ Sha1: "aaaa", Message: "update one.md" }] }),
              created: "2026-06-01T00:00:00Z",
            },
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/owner/w/activity", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("saved edits");
    expect(body).toContain("3 commits");
  });

  it("keeps issue links from Forgejo comment URLs when activity content has no index", async () => {
    const db = freshTestDb("cosheaf-web-activity-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/activities/feeds", (c) =>
          c.json([
            {
              id: 1,
              op_type: "comment_issue",
              act_user: { login: "alice" },
              comment: { id: 11, body: "noted", issue_url: "http://forgejo.test/api/v1/repos/owner/w/issues/7" },
              created: "2026-06-01T00:00:00Z",
            },
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/owner/w/activity", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("commented on");
    expect(body).toContain("/issues/7");
  });
});
