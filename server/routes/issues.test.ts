import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { issues } from "./issues.js";
import {
  responseEmpty as empty,
  fakeForgejo,
  freshTestDb,
  responseOk as ok,
  seedTestWorkspace,
  testApp,
  testConfig,
} from "./test-fixtures.js";

const config = testConfig("issues");

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-issues-");
  seedTestWorkspace(db);
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/api/v1/repos", issues));
}


function forgejoIssue(
  number: number,
  title: string,
  opts: { state?: "open" | "closed"; isPr?: boolean } = {},
): {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ id: number; name: string; color: string; exclusive?: boolean; is_archived?: boolean }>;
  comments: number;
  created_at: string;
  updated_at: string;
  user: { login: string };
  assignees: [];
  closed_at: null;
  pull_request?: object | null;
} {
  return {
    number,
    title,
    body: "",
    state: opts.state ?? "open",
    labels: [],
    comments: 0,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:01:00Z",
    user: { login: "alice" },
    assignees: [],
    closed_at: null,
    pull_request: opts.isPr ? {} : null,
  };
}

function forgejoActivity(id: number, username: string, refName: string, message: string, sha: string): object {
  return {
    id,
    op_type: "commit_repo",
    act_user: { login: username },
    ref_name: refName,
    content: JSON.stringify({ Commits: [{ Sha1: sha, Message: message }] }),
    created: `2026-05-24T00:00:0${id}Z`,
  };
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

describe("issues routes", () => {
  it("returns a tea-compatible issue array for Gitea token auth", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockResolvedValueOnce(ok([
      forgejoIssue(4, "Visible issue"),
      forgejoIssue(5, "Pull request", { isPr: true }),
    ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues?state=open", {
      headers: { authorization: `token ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ number: 4, title: "Visible issue", updated_at: "2026-05-20T00:01:00Z" }),
    ]);
  });

  it("rejects malformed issue creation payloads before contacting Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    for (const payload of [
      { title: { value: "bad" } },
      { title: "Valid", body: { text: "lost" } },
      { title: "Valid", labels: ["bug"] },
      { title: "Valid", labels: [0] },
    ]) {
      fetchMock.mockClear();
      const res = await appFor(db).request("/api/v1/repos/owner/w/issues", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("serves issue comments through Cosheaf DTOs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([
      {
        id: 101,
        body: "looks **good**",
        user: { login: "alice" },
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:01:00Z",
      },
    ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/comments", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/comments?page=1&limit=50",
    );
    await expect(res.json()).resolves.toMatchObject({
      comments: [
        {
          id: 101,
          body: "looks **good**",
          author_username: "alice",
        },
      ],
    });
  });

  it("lets Forgejo decide read-user issue comment permission", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "bob", role: "read" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok({
        id: 101,
        body: "question",
        user: { login: "bob" },
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:00:00Z",
      }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/comments", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "question" }),
    });

    expect(res.status).toBe(201);
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7/comments");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ body: "question" });
  });

  it("does not edit or delete comments outside the requested issue", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/8", body: "other", user: { login: "alice" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
    const edit = await appFor(db).request("/api/v1/repos/owner/w/issues/7/comments/123", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: "updated" }),
    });

    expect(edit.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/comments/123");

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/8", body: "other", user: { login: "alice" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
    const del = await appFor(db).request("/api/v1/repos/owner/w/issues/7/comments/123", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(del.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/comments/123");
  });

  it("edits an issue comment by id through the number-less route", async () => {
    const db = freshDb();
    // A read-access member may edit (Forgejo enforces author/admin), so the
    // write gate is bypassed for comment mutations.
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockResolvedValueOnce(ok({
      id: 55,
      body: "updated body",
      user: { login: "alice" },
      created_at: "2026-05-20T00:00:00Z",
      updated_at: "2026-05-20T00:05:00Z",
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/comments/55", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "updated body" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/comments/55");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ body: "updated body" });
    await expect(res.json()).resolves.toMatchObject({ id: 55, body: "updated body", author_username: "alice" });
  });

  it("deletes an issue comment by id through the number-less route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockResolvedValueOnce(empty());

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/comments/55", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/comments/55");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a bad comment id on the number-less route before contacting Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/comments/0", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates issue state through a typed route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Theorem", { state: "closed" }), labels: [], comments: 0 }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/state", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ state: "closed" });
    await expect(res.json()).resolves.toEqual({ ok: true, state: "closed" });
  });

  it("GET /issues/:number 404s on a missing issue instead of 500", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockResolvedValueOnce(empty(404));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/999", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("PATCH /issues/:number edits the Forgejo issue title and body", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Retitled"), body: "Updated" }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: " Retitled ", body: "Updated" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      title: "Retitled",
      body: "Updated",
    });
    await expect(res.json()).resolves.toMatchObject({ title: "Retitled", body: "Updated" });
  });

  it("does not mutate pull requests through typed issue edit routes", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "PR", { isPr: true })));
    const state = await appFor(db).request("/api/v1/repos/owner/w/issues/7/state", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
    });

    expect(state.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "PR", { isPr: true })));
    const edit = await appFor(db).request("/api/v1/repos/owner/w/issues/7", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Retitled" }),
    });

    expect(edit.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("does not mutate pull requests through typed issue-only routes", async () => {
    const cases: Array<{ method: string; path: string; body?: unknown; extraReads?: (forge: Hono) => void }> = [
      { method: "POST", path: "/api/v1/repos/owner/w/issues/7/comments", body: { body: "note" } },
      { method: "PATCH", path: "/api/v1/repos/owner/w/issues/7/comments/123", body: { body: "note" } },
      { method: "DELETE", path: "/api/v1/repos/owner/w/issues/7/comments/123" },
      {
        method: "PUT",
        path: "/api/v1/repos/owner/w/issues/7/labels",
        body: { labels: [1] },
        extraReads: (forge) => forge.get("/api/v1/repos/owner/w/labels", () => Response.json([{ id: 1, name: "bug", color: "ff0000" }])),
      },
      { method: "POST", path: "/api/v1/repos/owner/w/issues/7/pin" },
      { method: "DELETE", path: "/api/v1/repos/owner/w/issues/7/pin" },
      { method: "POST", path: "/api/v1/repos/owner/w/issues/7/dependencies", body: { index: 9 } },
      { method: "DELETE", path: "/api/v1/repos/owner/w/issues/7/dependencies", body: { index: 9 } },
    ];

    for (const testCase of cases) {
      const db = freshDb();
      const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
      let mutated = false;
      fetchMock.mockReset();
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        testCase.extraReads?.(forge);
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue(7, "PR", { isPr: true })));
        forge.post("/api/v1/repos/owner/w/issues/7/comments", () => {
          mutated = true;
          return Response.json({ id: 1 });
        });
        forge.patch("/api/v1/repos/owner/w/issues/comments/123", () => {
          mutated = true;
          return Response.json({ id: 123 });
        });
        forge.delete("/api/v1/repos/owner/w/issues/comments/123", () => {
          mutated = true;
          return new Response(null, { status: 204 });
        });
        forge.put("/api/v1/repos/owner/w/issues/7/labels", () => {
          mutated = true;
          return Response.json([]);
        });
        forge.post("/api/v1/repos/owner/w/issues/7/pin", () => {
          mutated = true;
          return new Response(null, { status: 204 });
        });
        forge.delete("/api/v1/repos/owner/w/issues/7/pin", () => {
          mutated = true;
          return new Response(null, { status: 204 });
        });
        forge.post("/api/v1/repos/owner/w/issues/7/dependencies", () => {
          mutated = true;
          return Response.json(forgejoIssue(7, "PR", { isPr: true }));
        });
        forge.delete("/api/v1/repos/owner/w/issues/7/dependencies", () => {
          mutated = true;
          return Response.json(forgejoIssue(7, "PR", { isPr: true }));
        });
      }));

      const res = await appFor(db).request(testCase.path, {
        method: testCase.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: testCase.body === undefined ? undefined : JSON.stringify(testCase.body),
      });

      expect(res.status, `${testCase.method} ${testCase.path}`).toBe(404);
      expect(mutated, `${testCase.method} ${testCase.path}`).toBe(false);
    }
  });

  it("does not create issue claims for pull request numbers", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "PR", { isPr: true })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ runner_name: "agent", purpose: "triage" }),
    });

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS c FROM issue_claims WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("does not heartbeat issue claims when the target number is a pull request", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    db.prepare(`
      INSERT INTO issue_claims (
        id, workspace_slug, issue_number, runner_name, purpose, holder_username,
        created_at, heartbeat_at, expires_at
      ) VALUES ('claim-1', 'owner/w', 7, 'agent', 'triage', 'alice', 1, 2, 9999999999999)
    `).run();
    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "PR", { isPr: true })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/claim/claim-1/heartbeat", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 30 }),
    });

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT heartbeat_at FROM issue_claims WHERE id = 'claim-1'").get()).toEqual({ heartbeat_at: 2 });
  });

  it("serves labels, milestones, and markdown rendering without backend-shaped paths", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 1, name: "bug", color: "ff0000", description: "broken", exclusive: false, is_archived: false }]))
      .mockResolvedValueOnce(ok([{ id: 2, title: "v1", description: "ship", state: "open", open_issues: 1, closed_issues: 0, due_on: null }]))
      .mockResolvedValueOnce(new Response("<p>Hello</p>", { status: 200, headers: { "content-type": "text/html" } }));

    const app = appFor(db);
    const labels = await app.request("/api/v1/repos/owner/w/labels", {
      headers: { authorization: `Bearer ${token}` },
    });
    const milestones = await app.request("/api/v1/repos/owner/w/milestones?state=all", {
      headers: { authorization: `Bearer ${token}` },
    });
    const markdown = await app.request("/api/v1/repos/owner/w/markdown/render", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(labels.status).toBe(200);
    expect(milestones.status).toBe(200);
    expect(markdown.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/labels?page=1&limit=50");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/milestones?state=all&page=1&limit=50");
    expect(String(fetchMock.mock.calls[2][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/markdown");
    await expect(markdown.json()).resolves.toEqual({ html: "<p>Hello</p>" });
  });

  it("filters mine as authored OR assigned by the current Forgejo user", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues?filter=mine&state=all&q=lemma", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("created_by=alice");
    expect(String(fetchMock.mock.calls[1][0])).toContain("assigned_by=alice");
  });

  it("filters assigned issues by the current Forgejo user", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues?filter=assigned", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("assigned_by=alice");
  });

  it("maps Forgejo-native issue filters", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request(
      "/api/v1/repos/owner/w/issues?state=all&labels=bug&milestones=2&created_by=test-meri&assigned_by=test-vera&q=refactor&sort=oldest",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("labels")).toBe("bug");
    expect(url.searchParams.get("milestones")).toBe("2");
    expect(url.searchParams.get("created_by")).toBe("test-meri");
    expect(url.searchParams.get("assigned_by")).toBe("test-vera");
    expect(url.searchParams.get("q")).toBe("refactor");
    expect(url.searchParams.get("sort")).toBe("oldest");
  });

  it("does not mask Forgejo upstream failures as missing issues", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(new Response("forgejo down", { status: 503 }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("not_found");
  });

  it("fills Forgejo owner/repo when adding an issue dependency", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(res.status).toBe(201);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/dependencies",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      index: 9,
      owner: "owner",
      repo: "w",
    });
    expect(await res.json()).toEqual({
      issue: { number: 7, title: "Theorem", state: "open", is_pr: false },
    });
  });

  it("fills Forgejo owner/repo when removing an issue dependency", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/dependencies", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/dependencies",
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      index: 9,
      owner: "owner",
      repo: "w",
    });
    expect(await res.json()).toEqual({
      issue: { number: 7, title: "Theorem", state: "open", is_pr: false },
    });
  });

  it("fills Forgejo owner/repo when removing an issue block", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/blocks", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7/blocks");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ index: 9, owner: "owner", repo: "w" });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("maps dependency and block lists to compact DTOs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([forgejoIssue(9, "Lemma"), forgejoIssue(11, "PR", { isPr: true })]))
      .mockResolvedValueOnce(ok([forgejoIssue(12, "Blocked theorem", { state: "closed" })]));

    const deps = await appFor(db).request("/api/v1/repos/owner/w/issues/7/dependencies", {
      headers: { authorization: `Bearer ${token}` },
    });
    const blocks = await appFor(db).request("/api/v1/repos/owner/w/issues/7/blocks", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(deps.status).toBe(200);
    expect(await deps.json()).toEqual({
      issues: [
        { number: 9, title: "Lemma", state: "open", is_pr: false },
        { number: 11, title: "PR", state: "open", is_pr: true },
      ],
    });
    expect(blocks.status).toBe(200);
    expect(await blocks.json()).toEqual({
      issues: [{ number: 12, title: "Blocked theorem", state: "closed", is_pr: false }],
    });
  });

  it("rejects newly assigning archived labels", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok([{ id: 3, name: "old", color: "888888", is_archived: true }]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [3] }),
    });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects multiple exclusive labels from the same scope", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok([
        { id: 1, name: "kind/bug", color: "ff0000", exclusive: true },
        { id: 2, name: "kind/task", color: "00ff00", exclusive: true },
      ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("only one label in scope kind");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat slashless exclusive labels as scoped labels", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const labels = [
      { id: 1, name: "bug", color: "ff0000", exclusive: true },
      { id: 2, name: "task", color: "00ff00", exclusive: true },
    ];
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(labels))
      .mockResolvedValueOnce(ok(labels));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      labels: [
        { name: "bug", scope: null },
        { name: "task", scope: null },
      ],
    });
  });

  it("allows keeping archived labels that are already attached", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const archived = { id: 3, name: "old", color: "888888", is_archived: true };
    fetchMock
      .mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Theorem"), labels: [archived] }))
      .mockResolvedValueOnce(ok([archived]))
      .mockResolvedValueOnce(ok([archived]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [3] }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/labels",
    );
    await expect(res.json()).resolves.toMatchObject({
      labels: [{ id: 3, name: "old", is_archived: true }],
    });
  });

  it("normalizes activity limits before forwarding to Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValue(ok([]));
    const app = appFor(db);

    await app.request("/api/v1/repos/owner/w/activities?limit=-5", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/repos/owner/w/activities?limit=abc", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/repos/owner/w/activities?limit=1.5", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/repos/owner/w/activities?limit=999", {
      headers: { authorization: `Bearer ${token}` },
    });

    const limits = fetchMock.mock.calls.map((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("limit");
    });
    expect(limits).toEqual(["1", "50", "50", "100"]);
  });

  it("collapses adjacent edit-branch commit activity", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([
      forgejoActivity(3, "alice", "refs/heads/user/alice/wip", "update three.md", "cccc"),
      forgejoActivity(2, "alice", "refs/heads/user/alice/wip", "update two.md", "bbbb"),
      forgejoActivity(1, "alice", "refs/heads/user/alice/wip", "update one.md", "aaaa"),
      forgejoActivity(4, "alice", "refs/heads/main", "merge pull request", "dddd"),
    ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/activities", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activities: [
        {
          id: 3,
          op_type: "commit_repo",
          ref_name: "refs/heads/user/alice/wip",
          commit_sha: "cccc",
          commit_message: "update three.md",
          repeat_count: 3,
        },
        {
          id: 4,
          op_type: "commit_repo",
          ref_name: "refs/heads/main",
          repeat_count: 1,
        },
      ],
    });
  });

  it("rejects malformed and self dependency mutations before calling Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const app = appFor(db);

    const badBody = await app.request("/api/v1/repos/owner/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9.5 }),
    });
    const booleanBody = await app.request("/api/v1/repos/owner/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: true }),
    });
    const self = await app.request("/api/v1/repos/owner/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 7 }),
    });
    const badParam = await app.request("/api/v1/repos/owner/w/issues/7.5/dependencies", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });
    const decimalStringParam = await app.request("/api/v1/repos/owner/w/issues/7.0/dependencies", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({
      error: "dependency issue number required",
      code: "validation",
    });
    expect(booleanBody.status).toBe(400);
    expect(await booleanBody.json()).toEqual({
      error: "dependency issue number required",
      code: "validation",
    });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({
      error: "issue cannot depend on itself",
      code: "validation",
    });
    expect(badParam.status).toBe(400);
    expect(decimalStringParam.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits a label through a typed PATCH route, forwarding only sent fields", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok({ id: 5, name: "bug", color: "ff0000", description: "" }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/labels/5", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: " bug ", color: "#ff0000" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/labels/5");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ name: "bug", color: "ff0000" });
    await expect(res.json()).resolves.toMatchObject({ id: 5, name: "bug" });
  });

  it("rejects an invalid label color on PATCH before reaching Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const res = await appFor(db).request("/api/v1/repos/owner/w/labels/5", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ color: "nothex" }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty label PATCH payloads before reaching Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const res = await appFor(db).request("/api/v1/repos/owner/w/labels/5", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ exclusive: "yes" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "label field required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a label through a typed DELETE route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));

    const res = await appFor(db).request("/api/v1/repos/owner/w/labels/5", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/labels/5");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("returns 404 when deleting a missing label", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/labels/999", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("edits and closes a milestone through typed routes", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok({ id: 3, title: "v1", description: "", state: "closed", open_issues: 0, closed_issues: 2, created_at: "2026-05-20T00:00:00Z" }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/milestones/3", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "v1", state: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/milestones/3");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ title: "v1", state: "closed" });
    await expect(res.json()).resolves.toMatchObject({ id: 3, state: "closed" });
  });

  it("rejects empty milestone PATCH payloads before reaching Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const res = await appFor(db).request("/api/v1/repos/owner/w/milestones/3", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "done" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "milestone field required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a milestone through a typed DELETE route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(empty(204));

    const res = await appFor(db).request("/api/v1/repos/owner/w/milestones/3", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("sets and clears an issue milestone through the typed issue route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    fetchMock
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const set = await appFor(db).request("/api/v1/repos/owner/w/issues/7/milestone", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: 3 }),
    });
    const clear = await appFor(db).request("/api/v1/repos/owner/w/issues/7/milestone", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: null }),
    });

    expect(set.status).toBe(200);
    expect(clear.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ milestone: 3 });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ milestone: 0 });
  });

  it("rejects PR numbers and backend sentinel ids on the typed issue milestone route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const badId = await appFor(db).request("/api/v1/repos/owner/w/issues/7/milestone", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: 0 }),
    });
    expect(badId.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "PR", { isPr: true })));
    const pr = await appFor(db).request("/api/v1/repos/owner/w/issues/7/milestone", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ id: 3 }),
    });

    expect(pr.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("rejects label/milestone mutations from a read-only user", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "bob", role: "read" });
    const patchLabel = await appFor(db).request("/api/v1/repos/owner/w/labels/5", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    const delMilestone = await appFor(db).request("/api/v1/repos/owner/w/milestones/3", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(patchLabel.status).toBe(403);
    expect(delMilestone.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes PR-close causality in the timeline (#93)", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    // pagedList walks: return the events then an empty page.
    fetchMock
      .mockResolvedValueOnce(ok([
        {
          id: 1, type: "pull_ref", ref_action: "closes",
          ref_issue: { number: 42, title: "Fix the thing", state: "closed", pull_request: { merged: true, merged_at: "2026-05-20T00:00:00Z" } },
          user: { id: 2, login: "bob" }, created_at: "2026-05-20T00:00:00Z",
        },
        { id: 2, type: "merge_pull", user: { id: 2, login: "bob" }, created_at: "2026-05-20T00:01:00Z" },
        { id: 3, type: "close", user: { id: 3, login: "carol" }, created_at: "2026-05-20T00:02:00Z" },
      ]))
      .mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/timeline", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: Array<Record<string, unknown>> };
    // pull_ref names the closing PR and that it merged.
    expect(events[0]).toMatchObject({
      type: "pull_ref",
      ref_action: "closes",
      ref_issue: { number: 42, title: "Fix the thing", state: "closed", is_pull: true, pull_merged: true },
    });
    // merge_pull is distinguishable from a manual close.
    expect(events[1].type).toBe("merge_pull");
    expect(events[2]).toMatchObject({ type: "close", ref_issue: null, ref_action: null });
  });

  it("leaves ref_issue null for a manual close and a bare-number legacy ref", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([
        { id: 1, type: "close", user: { id: 3, login: "carol" }, created_at: "2026-05-20T00:00:00Z" },
        { id: 2, type: "comment_ref", ref_issue: 99, ref_action: "neutral", user: { id: 2, login: "bob" }, created_at: "2026-05-20T00:01:00Z" },
      ]))
      .mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/issues/7/timeline", {
      headers: { authorization: `Bearer ${token}` },
    });
    const { events } = (await res.json()) as { events: Array<Record<string, unknown>> };
    expect(events[0]).toMatchObject({ type: "close", ref_issue: null });
    // a legacy bare-number ref_issue is treated as null (no causality object).
    expect(events[1].ref_issue).toBe(null);
  });
});
