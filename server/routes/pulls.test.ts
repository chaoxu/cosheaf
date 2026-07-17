// Route-level tests for the typed /pulls/* and /branches/* endpoints. The
// Forgejo client is real; `fetch` is mocked. The
// permission cache is pre-seeded per test so we exercise only the
// request actually under test against the mock.

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import type { Role } from "../../shared/roles.js";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { classifyMergeFailure } from "../merge-failure.js";
import { branches } from "./branches.js";
import { pulls } from "./pulls.js";
import {
  fakeForgejo,
  fakeWorkspaceBackend,
  freshTestDb,
  responseEmpty as empty,
  responseOk as ok,
  seedTestWorkspace,
  testApp,
  testConfig,
  testLocalRouteApp,
} from "./test-fixtures.js";
import { WorkspaceBackendError } from "../workspace-backend.js";

const config = testConfig("pulls");

function freshDb(): Database.Database {
  return freshTestDb("cosheaf-pulls-");
}

function seedUser(db: Database.Database, id: number, username: string, role: Role): string {
  return seedAuthUser(db, config, { id, username, role, owner: "owner", repo: "w" });
}

function seedWorkspace(db: Database.Database): void {
  seedTestWorkspace(db);
}

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => {
    app.route("/api/v1/repos", pulls);
    app.route("/api/v1/repos", branches);
  });
}

function localBranchAppFor(db: Database.Database, backend = fakeWorkspaceBackend()): Hono<AppEnv> {
  return testLocalRouteApp(db, config, backend, (app) => app.route("/api/v1/repos", branches));
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

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    number: 7,
    title: "t",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: "2026-05-16T00:00:00Z",
    merged_at: null,
    user: { login: "alice" },
    head: { ref: "user/alice/wip", sha: "h" },
    base: { ref: "main", sha: "b" },
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 99,
    state: "COMMENT",
    body: "question",
    user: { login: "test-bob" },
    submitted_at: "2026-05-16T00:00:00Z",
    ...overrides,
  };
}

describe("pulls + branches routes", () => {
  it("GET /pulls returns stable Cosheaf PR metadata", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([
      pull({ number: 8, title: "Update docs", head: { ref: "agent/wip", sha: "h8" } }),
    ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls?state=all", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/pulls?state=all&sort=recentupdate&page=1&limit=50",
    );
    await expect(res.json()).resolves.toMatchObject({
      pulls: [
        {
          number: 8,
          title: "Update docs",
          author_username: "alice",
          head_ref: "agent/wip",
          base_ref: "main",
        },
      ],
    });
  });

  it("GET /pulls returns a tea-compatible array for Gitea token auth", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([
      pull({ number: 8, title: "Update docs", head: { ref: "agent/wip", sha: "h8" } }),
    ]));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls?state=open", {
      headers: { authorization: `token ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ number: 8, title: "Update docs", head: expect.objectContaining({ ref: "agent/wip" }) }),
    ]);
  });

  it("GET /pulls maps Forgejo-native filters", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request(
      "/api/v1/repos/owner/w/pulls?state=all&labels=4,5&milestone=2&author=test-meri&sort=oldest",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("labels")).toBe("4,5");
    expect(url.searchParams.getAll("labels")).toEqual(["4,5"]);
    expect(url.searchParams.get("milestone")).toBe("2");
    expect(url.searchParams.get("poster")).toBe("test-meri");
    expect(url.searchParams.get("sort")).toBe("oldest");
  });

  it("GET /pulls does not coerce malformed numeric filters", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request(
      "/api/v1/repos/owner/w/pulls?labels=4.0,1e2&milestone=2.0",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.has("labels")).toBe(false);
    expect(url.searchParams.has("milestone")).toBe(false);
  });

  it("GET /pulls/:n returns stable Cosheaf PR metadata", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok(pull({ number: 7, title: "Review me" })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7");
    await expect(res.json()).resolves.toMatchObject({
      pull: {
        number: 7,
        title: "Review me",
        head_ref: "user/alice/wip",
        base_ref: "main",
      },
    });
  });

  it("PATCH /pulls/:n edits the Forgejo PR title and body", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok(pull({ number: 7, title: "Retitled", body: "Updated body" })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: " Retitled ", body: "Updated body" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      title: "Retitled",
      body: "Updated body",
    });
    await expect(res.json()).resolves.toMatchObject({ pull: { title: "Retitled", body: "Updated body" } });
  });

  it("PUT /pulls/:n/labels validates scoped labels before editing Forgejo PR labels", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock
      .mockResolvedValueOnce(ok([
        { id: 1, name: "kind/bug", color: "ff0000", exclusive: true },
        { id: 2, name: "kind/task", color: "00ff00", exclusive: true },
      ]))
      .mockResolvedValueOnce(ok(pull({ labels: [] })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("PUT /pulls/:n/labels writes valid labels through Forgejo", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const label = { id: 1, name: "kind/bug", color: "ff0000", exclusive: true };
    fetchMock
      .mockResolvedValueOnce(ok([label]))
      .mockResolvedValueOnce(ok(pull({ labels: [] })))
      .mockResolvedValueOnce(ok(pull({ labels: [label] })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1] }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[2][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7");
    expect(fetchMock.mock.calls[2][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ labels: [1] });
    await expect(res.json()).resolves.toMatchObject({ pull: { labels: [{ name: "kind/bug", scope: "kind" }] } });
  });

  it("PUT /pulls/:n/labels allows slashless exclusive labels", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const labels = [
      { id: 1, name: "bug", color: "ff0000", exclusive: true },
      { id: 2, name: "task", color: "00ff00", exclusive: true },
    ];
    fetchMock
      .mockResolvedValueOnce(ok(labels))
      .mockResolvedValueOnce(ok(pull({ labels: [] })))
      .mockResolvedValueOnce(ok(pull({ labels })));

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      pull: {
        labels: [
          { name: "bug", scope: null },
          { name: "task", scope: null },
        ],
      },
    });
  });

  describe("admin-only gates (cache-bypassed)", () => {
    it("POST /pulls/:n/merge rejects a write user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // Fresh permission lookup says write.
      fetchMock.mockResolvedValueOnce(ok({ permission: "write" }));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/merge admin path bypasses the role cache (fresh fetch)", async () => {
      const db = freshDb();
      seedWorkspace(db);
      // Cache says admin, but the live fetch revokes it. The cache-bypassing
      // middleware should re-fetch and deny.
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "read" })); // requireAdminFresh
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /settings rejects a write user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock.mockResolvedValueOnce(ok({ permission: "write" }));
      const res = await appFor(db).request("/api/v1/repos/owner/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ min_approvals: 2 }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /settings rejects unknown markdown formats", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock.mockResolvedValueOnce(ok({ permission: "admin" }));
      const res = await appFor(db).request("/api/v1/repos/owner/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ default_md_format: "unknown" }),
      });
      expect(res.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("PUT /settings accepts zero required approvals", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" }))
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 2 }))
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 0 }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ min_approvals: 0 }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { min_approvals: number };
      expect(body.min_approvals).toBe(0);
      const updateCall = fetchMock.mock.calls[2];
      expect(String(updateCall?.[0] ?? "")).toContain("/api/v1/repos/owner/w/branch_protections/main");
      expect(JSON.parse(String((updateCall?.[1] as RequestInit | undefined)?.body ?? "{}"))).toEqual({
        required_approvals: 0,
      });
    });

    it("PUT /settings rejects non-object JSON payloads before settings reads", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      fetchMock.mockResolvedValue(ok({ permission: "admin" }));

      for (const payload of ["[]", "\"noop\""]) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(ok({ permission: "admin" }));
        const res = await appFor(db).request("/api/v1/repos/owner/w/settings", {
          method: "PUT",
          headers,
          body: payload,
        });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "settings payload required" });
        expect(fetchMock).toHaveBeenCalledOnce();
      }
    });

    it("PUT /settings accepts legacy coflat format payload as a no-op", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" }))
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 1 }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ default_md_format: COFLAT_FORMAT_ID }),
      });

      expect(res.status).toBe(200);
      const topicsPutCall = fetchMock.mock.calls.find((call) => {
        const url = String(call[0] ?? "");
        const init = (call[1] ?? {}) as RequestInit;
        return url.includes("/repos/owner/w/topics") && (init.method ?? "GET").toUpperCase() === "PUT";
      });
      expect(topicsPutCall, "Forgejo /topics PUT should not be called for fixed Coflat format").toBeUndefined();
    });
  });

  describe("write+ gates", () => {
    it("POST /pulls/:n/reviews lets Forgejo decide read-user comment permission", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      fetchMock
        .mockResolvedValueOnce(ok(pull({ user: { login: "alice" } })))
        .mockResolvedValueOnce(ok(review()))
        .mockResolvedValueOnce(ok([]));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "COMMENT", body: "question" }),
      });
      expect(res.status).toBe(200);
      expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7/reviews");
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
        event: "COMMENT",
        body: "question",
      });
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        review: { id: 99, username: "test-bob", decision: "comment", comment: "question" },
      });
    });

    it("POST /pulls/:n/close rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/close", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/reopen sets the Forgejo PR state to open", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock.mockResolvedValueOnce(ok(pull({ number: 7, state: "open" })));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reopen", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7");
      expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ state: "open" });
      await expect(res.json()).resolves.toEqual({ ok: true });
    });

    it("POST /pulls/:n/reopen rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reopen", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/comments lets Forgejo decide read-user line-comment permission", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const diff = [
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n");
      fetchMock
        .mockResolvedValueOnce(ok(pull({ user: { login: "alice" } })))
        .mockResolvedValueOnce(new Response(diff, { status: 200 }))
        .mockResolvedValueOnce(ok({ id: 99 }));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "x.md", line: 1, side: "head", body: "hi" }),
      });
      expect(res.status).toBe(200);
      expect(String(fetchMock.mock.calls[2][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls/7/reviews");
      expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
        event: "COMMENT",
        comments: [{ path: "x.md", body: "hi", new_position: 1 }],
      });
    });

    it("POST /pulls/:n/comments rejects bad shapes before reaching Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const post = (body: unknown) =>
        appFor(db).request("/api/v1/repos/owner/w/pulls/42/comments", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      // invalid side (the old "new"/"old" vocab is no longer accepted)
      expect((await post({ path: "x.md", line: 1, side: "new", body: "hi" })).status).toBe(400);
      // line must be a positive integer
      expect((await post({ path: "x.md", line: 0, side: "head", body: "hi" })).status).toBe(400);
      expect((await post({ path: "x.md", line: 1.5, side: "head", body: "hi" })).status).toBe(400);
      // path must pass the shared repo-path validator
      expect((await post({ path: "../etc/passwd", line: 1, side: "head", body: "hi" })).status).toBe(400);
      expect((await post({ path: "", line: 1, side: "head", body: "hi" })).status).toBe(400);
      // body must be non-empty
      expect((await post({ path: "x.md", line: 1, side: "head", body: "  \n" })).status).toBe(400);
      // No fetch should have been made — all rejections happen at parse time.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("review requests", () => {
    it("GET /pulls/:n/review-requests returns requested and available reviewers", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(ok(pull({
          requested_reviewers: [{ login: "test-vera" }],
          requested_reviewers_teams: [{ name: "analysis" }],
          user: { login: "alice" },
        })))
        .mockResolvedValueOnce(ok([{ login: "alice" }, { login: "test-vera" }, { login: "test-meri" }]));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/review-requests", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        requested_reviewers: ["test-vera"],
        requested_reviewer_teams: ["analysis"],
        available_reviewers: ["test-vera", "test-meri"],
      });
    });

    it("POST /pulls/:n/review-requests requests reviewers through Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok(pull({ requested_reviewers: [{ login: "test-vera" }] })));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/review-requests", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reviewers: ["test-vera", "test-vera", "  "] }),
      });

      expect(res.status).toBe(201);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        "http://forgejo.test/api/v1/repos/owner/w/pulls/7/requested_reviewers",
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewers: ["test-vera"] });
      await expect(res.json()).resolves.toMatchObject({ pull: { requested_reviewers: ["test-vera"] } });
    });

    it("rejects malformed reviewer arrays before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/review-requests", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reviewers: ["test-vera", 42] }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "reviewers required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("DELETE /pulls/:n/review-requests cancels reviewers through Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(empty(204))
        .mockResolvedValueOnce(ok(pull({ requested_reviewers: [] })));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/review-requests", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reviewers: ["test-vera"] }),
      });

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewers: ["test-vera"] });
    });
  });

  describe("POST /pulls dedup + clean errors (#181)", () => {
    const dup409 = () =>
      new Response(
        '{"message":"pull request already exists for these targets [id: 890, issue_id: 2, head_branch: user/chao/web-edit, base_branch: main]","url":"http://jupiter:3002/api/swagger"}',
        { status: 409 },
      );

    it("returns the existing CLOSED PR on a duplicate 409 (navigate, not error)", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(dup409()) // createPull -> Forgejo 409
        // listPulls(state:"all") finds the closed-unmerged PR for this head->base
        .mockResolvedValueOnce(
          ok([pull({ number: 2, state: "closed", merged: false, head: { ref: "user/chao/web-edit", sha: "h" }, base: { ref: "main", sha: "b" } })]),
        );
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ head: "user/chao/web-edit", base: "main", title: "x" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ number: 2 });
      // The dedup lookup must query all states, not just open ones.
      expect(String(fetchMock.mock.calls[1][0])).toMatch(/state=all/);
    });

    it("never leaks Forgejo's raw body when no existing PR matches", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(dup409()) // createPull -> 409 (e.g. empty diff)
        .mockResolvedValueOnce(ok([])); // listPulls: nothing matches
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ head: "user/chao/web-edit", base: "main", title: "x" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toMatch(/jupiter|:30\d\d|api\/swagger|\{|http:\/\//);
      expect(body.error).toMatch(/pull request/i);
    });
  });

  describe("self-review block", () => {
    it("POST /pulls/:n/reviews returns 403 when the PR is the caller's", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // GET /pulls/7 → returns a PR authored by alice (the caller).
      fetchMock.mockResolvedValueOnce(ok(pull({ user: { login: "alice" } })));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/own pull request/);
    });

    it("POST /pulls/:n/reviews rejects inherited event keys before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "toString" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "validation",
        error: "event must be APPROVE|REQUEST_CHANGES|COMMENT",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POST /pulls/:n/reviews rejects malformed body text before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "APPROVE", body: { text: "looks good" } }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "validation",
        error: "body must be a string",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("pending review ids", () => {
    it("rejects fractional pending review ids before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const submit = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/1.5/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ event: "approve" }),
      });
      const comment = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/1.5/comments", {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "x.md", line: 1, side: "head", body: "hi" }),
      });

      expect(submit.status).toBe(400);
      expect(comment.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects invalid pending-review submit events before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/1/submit", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "bogus" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: "validation", error: "invalid event" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects malformed pending-review submit body text before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/1/submit", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "approve", body: { text: "looks good" } }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: "validation", error: "body must be a string" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POST /pending-review returns the pending review DTO", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(pull({ user: { login: "bob" } })));
        forge.get("/api/v1/repos/owner/w/pulls/7/reviews", () => Response.json([]));
        forge.post("/api/v1/repos/owner/w/pulls/7/reviews", () =>
          Response.json(review({ id: 9, state: "PENDING", body: "(pending)", user: { login: "alice" } })),
        );
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        review_id: 9,
        review: { id: 9, username: "alice", decision: "pending", comment: "(pending)" },
      });
    });

    it("rejects pending-review mutations for foreign or non-pending review ids", async () => {
      const reviewCases = [
        { label: "missing", reviews: [] },
        { label: "wrong user", reviews: [{ id: 9, state: "PENDING", body: "", user: { login: "mallory" } }] },
        { label: "submitted", reviews: [{ id: 9, state: "APPROVED", body: "", user: { login: "alice" } }] },
      ];
      const endpointCases = [
        {
          methodPath: "/api/v1/repos/owner/w/pulls/7/pending-review/9/submit",
          body: { event: "approve" },
          mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9",
        },
        {
          methodPath: "/api/v1/repos/owner/w/pulls/7/pending-review/9/comments",
          body: { path: "x.md", line: 1, side: "head", body: "hi" },
          mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9/comments",
        },
      ];

      for (const reviewCase of reviewCases) {
        for (const endpointCase of endpointCases) {
          const db = freshDb();
          seedWorkspace(db);
          const token = seedUser(db, 1, "alice", "write");
          let mutated = false;
          fetchMock.mockReset();
          fetchMock.mockImplementation(fakeForgejo((forge) => {
            forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(pull({ user: { login: "bob" } })));
            forge.get("/api/v1/repos/owner/w/pulls/7/reviews", () => Response.json(reviewCase.reviews));
            forge.post(endpointCase.mutationPath, () => {
              mutated = true;
              return Response.json({ id: 9 });
            });
          }));

          const res = await appFor(db).request(endpointCase.methodPath, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(endpointCase.body),
          });

          expect(res.status, `${reviewCase.label} ${endpointCase.methodPath}`).toBe(404);
          expect(mutated, `${reviewCase.label} ${endpointCase.methodPath}`).toBe(false);
        }
      }
    });

    it("gates pending-review submit: closed and author-approve rejected, author-comment allowed (#274)", async () => {
      const selfPull = pull(); // authored by alice
      const closedPull = pull({ state: "closed", user: { login: "bob" } });
      const submit = "/api/v1/repos/owner/w/pulls/7/pending-review/9/submit";
      const addComment = "/api/v1/repos/owner/w/pulls/7/pending-review/9/comments";
      const cases = [
        // Closed pull: every pending-review mutation rejected.
        { label: "closed submit", pull: closedPull, path: submit, body: { event: "approve" }, mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9", status: 403 },
        { label: "closed add-comment", pull: closedPull, path: addComment, body: { path: "x.md", line: 1, side: "head", body: "hi" }, mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9/comments", status: 403 },
        // Author of the PR: approve/request_changes rejected, but a plain COMMENT
        // verdict on their own PR is allowed (the inline line-comment path).
        { label: "self approve", pull: selfPull, path: submit, body: { event: "approve" }, mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9", status: 403 },
        { label: "self comment", pull: selfPull, path: submit, body: { event: "comment" }, mutationPath: "/api/v1/repos/owner/w/pulls/7/reviews/9", status: 200 },
      ];

      for (const tc of cases) {
        const db = freshDb();
        seedWorkspace(db);
        const token = seedUser(db, 1, "alice", "write");
        let mutated = false;
        fetchMock.mockReset();
        fetchMock.mockImplementation(fakeForgejo((forge) => {
          forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(tc.pull));
          forge.get("/api/v1/repos/owner/w/pulls/7/reviews", () =>
            Response.json([{ id: 9, state: "PENDING", body: "", user: { login: "alice" } }]),
          );
          forge.post(tc.mutationPath, () => {
            mutated = true;
            return Response.json(review({ id: 9, state: "COMMENT", body: "", user: { login: "alice" } }));
          });
        }));

        const res = await appFor(db).request(tc.path, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(tc.body),
        });

	        expect(res.status, tc.label).toBe(tc.status);
	        expect(mutated, tc.label).toBe(tc.status === 200);
	        if (tc.status === 200) {
	          await expect(res.json()).resolves.toMatchObject({
	            ok: true,
	            review: { id: 9, username: "alice", decision: "comment" },
	          });
	        }
	      }
    });

    // The position-form review-comments route is the Origin-proxy entry point:
    // the local Workbench resolves the diff anchor itself and forwards the forge
    // positions, so this route forwards them straight to addCommentToReview
    // without a local line→position resolution step.
    it("POST /pulls/:n/pending-review/:rid/review-comments forwards positions to the forge", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      let commentBody: unknown;
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(pull({ user: { login: "bob" } })));
        forge.get("/api/v1/repos/owner/w/pulls/7/reviews", () =>
          Response.json([{ id: 9, state: "PENDING", body: "", user: { login: "alice" } }]),
        );
        forge.post("/api/v1/repos/owner/w/pulls/7/reviews/9/comments", async (c) => {
          commentBody = await c.req.json();
          return Response.json({ id: 5 });
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/9/review-comments", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "x.md", body: "nit", new_position: 12 }),
      });

      expect(res.status).toBe(200);
      expect(commentBody).toEqual({ path: "x.md", body: "nit", new_position: 12 });
    });

    it("POST /pulls/:n/pending-review/:rid/review-comments rejects missing positions before the forge", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/pending-review/9/review-comments", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "x.md", body: "nit" }),
      });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /pulls/:n/file raw side reads", () => {
    it("reads renamed files from the previous path on the immutable base SHA", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "read");
      const rawRequests: Array<{ path: string; ref: string | undefined }> = [];
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () =>
          ok(pull({ head: { ref: "user/alice/wip", sha: "head-sha" }, base: { ref: "main", sha: "base-sha" } })),
        );
        forge.get("/api/v1/repos/owner/w/pulls/7/files", () =>
          ok([{ filename: "new.md", previous_filename: "old.md", status: "renamed", additions: 1, deletions: 1, changes: 2 }]),
        );
        forge.get("/api/v1/repos/owner/w/raw/:path", (c) => {
          rawRequests.push({ path: c.req.param("path"), ref: c.req.query("ref") });
          return c.text("# Old\n");
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/file?path=new.md&side=base", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ content: "# Old\n" });
      expect(rawRequests).toEqual([{ path: "old.md", ref: "base-sha" }]);
    });
  });

  describe("GET /pulls/:n/comments line/side mapping", () => {
    const addedFile = ["diff --git a/new.md b/new.md", "new file mode 100644", "--- /dev/null", "+++ b/new.md", "@@ -0,0 +1,2 @@", "+alpha", "+beta"].join("\n");
    const deletedFile = ["diff --git a/gone.md b/gone.md", "deleted file mode 100644", "--- a/gone.md", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x", "-y"].join("\n");
    const comment = (over: Record<string, unknown>) => ({
      id: 1, pull_request_review_id: 9, path: "new.md", body: "note", position: 1, original_position: 1,
      commit_id: "c", original_commit_id: "c", diff_hunk: "", user: { id: 2, login: "bob" },
      created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z", ...over,
    });

    it("maps position to file line+side and flags outdated / deleted-file fallbacks", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "read");
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7/comments", (c) => c.json([
          comment({ id: 1, path: "new.md", position: 1, original_position: 1 }),            // live head comment
          comment({ id: 2, path: "new.md", position: null, original_position: 1 }),         // outdated, line via original_position
          comment({ id: 3, path: "gone.md", position: null, original_position: null }),     // no position resolves -> deleted-file side fallback
        ]));
        forge.get("/api/v1/repos/owner/w/pulls/7/files", (c) => c.json([
          { filename: "new.md", status: "added", additions: 2, deletions: 0, changes: 2 },
          { filename: "gone.md", status: "deleted", additions: 0, deletions: 2, changes: 2 },
        ]));
        forge.get("/api/v1/repos/owner/w/pulls/7.diff", (c) => c.text(`${addedFile}\n${deletedFile}`));
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const { comments } = (await res.json()) as { comments: Array<{ id: number; line: number | null; side: string; outdated: boolean; author_username: string }> };
      expect(comments.find((c) => c.id === 1)).toMatchObject({ line: 1, side: "head", outdated: false, author_username: "bob" });
      // position 0/null with a base anchor -> base side at original_position (no freshness signal -> not outdated)
      expect(comments.find((c) => c.id === 2)).toMatchObject({ line: 1, side: "base", outdated: false });
      // no anchor resolves -> line null, side falls back to base for a deleted file
      expect(comments.find((c) => c.id === 3)).toMatchObject({ line: null, side: "base", outdated: true });
    });
  });

  describe("merge with retry", () => {
    it("POST /pulls/:n/merge rejects invalid merge methods before calling Forgejo merge", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock.mockResolvedValueOnce(ok({ permission: "admin" })); // requireAdminFresh

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "typo" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Do must be squash, merge, or rebase" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("POST /pulls/:n/merge retries on Forgejo 405 'try again later' and eventually succeeds", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("Please try again later", { status: 405 }))
        .mockResolvedValueOnce(empty(200)) // merge succeeds
        .mockResolvedValueOnce(ok(pull({ head: { ref: "user/alice/wip", sha: "h" } }))) // GET pull
        .mockResolvedValueOnce(empty(204)); // delete branch
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(200);
      // 405 + retry + getPull + deleteBranch + (admin-fresh perm) = 5 fetches
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("POST /pulls/:n/merge classifies a real conflict (mergeable:false) with SHAs", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("PR has merge conflicts", { status: 405 }))
        .mockResolvedValueOnce(ok(pull({ mergeable: false }))); // re-read PR
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "conflict", reason: "conflict", mergeable: false, head_sha: "h", base_sha: "b", state: "open", merged: false });
    });

    it("POST /pulls/:n/merge returns an actionable 'empty' 409 when a 5xx squash has no changes to merge (#401)", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("git commit: exit status 1", { status: 500 })) // empty squash 500s
        .mockResolvedValueOnce(ok([])); // listPullFiles: no changed files → PR already in base
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("empty");
      expect(body.error).toContain("no changes to merge");
    });

    it("POST /pulls/:n/merge still reports a 5xx as upstream unavailable when the PR is not empty", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("boom", { status: 500 })) // backend sick
        .mockResolvedValueOnce(ok([{ filename: "a.md", status: "modified", additions: 1, deletions: 0 }])); // real changes
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(502);
      expect((await res.json()) as { code: string }).toMatchObject({ code: "upstream" });
    });

    it("POST /pulls/:n/merge classifies a needs-approval block structurally, not by message text", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("not allowed to merge", { status: 405 })) // body text gives no hint
        .mockResolvedValueOnce(ok(pull({ mergeable: true }))) // re-read PR: no content conflict
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 1 })) // base branch protection
        .mockResolvedValueOnce(ok([])); // listReviews: zero approvals
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "blocked", mergeable: true });
    });

    it("does not classify unreadable review state as approval-blocked", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("not allowed to merge", { status: 405 }))
        .mockResolvedValueOnce(ok(pull({ mergeable: true }))) // re-read PR: no content conflict
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 1 }))
        .mockResolvedValueOnce(new Response("reviews unavailable", { status: 503 }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ reason: "unknown", mergeable: true });
    });

    it("POST /pulls/:n/merge on a closed-but-existing PR returns 409 closed, not a 404 'no longer exists'", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("pull request is closed", { status: 404 })) // merge: Forgejo 404 on a non-open PR
        .mockResolvedValueOnce(ok(pull({ state: "closed", merged: false }))); // re-read: the PR still exists, closed
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "conflict", reason: "closed", state: "closed", merged: false });
    });

    it("POST /pulls/:n/merge on a genuinely missing PR still returns 404 not-found", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("not found", { status: 404 })) // merge: 404
        .mockResolvedValueOnce(new Response("not found", { status: 404 })); // re-read: PR truly gone
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    });
  });

  describe("classifyMergeFailure (#94)", () => {
    const p = (o: Record<string, unknown> = {}) => pull(o) as unknown as Parameters<typeof classifyMergeFailure>[0];
    const noGate = null;
    it("flags a real content conflict", () => {
      expect(classifyMergeFailure(p({ mergeable: false }), noGate, false).reason).toBe("conflict");
    });
    it("flags an already-merged PR as stale", () => {
      expect(classifyMergeFailure(p({ merged: true, state: "closed" }), noGate, false).reason).toBe("stale");
    });
    it("flags a gone PR (null) as stale with null shas", () => {
      const r = classifyMergeFailure(null, noGate, false);
      expect(r).toMatchObject({ reason: "stale", head_sha: null, base_sha: null, mergeable: null });
    });
    it("flags a closed-but-unmerged PR as closed (not conflict), state closed", () => {
      const r = classifyMergeFailure(p({ state: "closed", merged: false, mergeable: false }), noGate, false);
      expect(r).toMatchObject({ reason: "closed", state: "closed", merged: false });
      expect(r.error).toBe("This pull request is closed; reopen it before merging.");
    });
    it("flags an unmet approval gate as blocked", () => {
      const gate = { requiredApprovals: 2, approvals: 1, rejections: 0 };
      expect(classifyMergeFailure(p({ mergeable: true }), gate, false).reason).toBe("blocked");
    });
    it("flags requested-changes as blocked", () => {
      const gate = { requiredApprovals: 0, approvals: 0, rejections: 1 };
      expect(classifyMergeFailure(p({ mergeable: true }), gate, false).reason).toBe("blocked");
    });
    it("a satisfied gate is not blocked (falls through to unknown)", () => {
      const gate = { requiredApprovals: 1, approvals: 1, rejections: 0 };
      expect(classifyMergeFailure(p({ mergeable: true }), gate, false).reason).toBe("unknown");
    });
    it("flags still-computing mergeability as transient", () => {
      expect(classifyMergeFailure(p({ mergeable: null }), noGate, true).reason).toBe("transient");
    });
    it("never leaks Forgejo's raw body text — error is a clean reason-based sentence", () => {
      const gate = { requiredApprovals: 1, approvals: 0, rejections: 0 };
      const blocked = classifyMergeFailure(p({ mergeable: true }), gate, false);
      expect(blocked.error).toBe("This pull request needs its required approvals before it can merge.");
      expect(blocked.error).not.toMatch(/http|:30\d\d|api\/swagger|\{/);
    });
  });

  describe("branches", () => {
    it("GET /branches has a hosted smoke over the normal auth/backend wiring", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "read");
      fetchMock.mockResolvedValueOnce(ok([{ name: "main", commit: { id: "1111111111111111111111111111111111111111" } }]));

      const res = await appFor(db).request("/api/v1/repos/owner/w/branches", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([
        {
          name: "main",
          commit: {
            id: "1111111111111111111111111111111111111111",
            url: "http://localhost/owner/w/commit/1111111111111111111111111111111111111111",
          },
        },
      ]);
    });

    it("GET /branches returns backend branches with public commit links", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const mainSha = "1111111111111111111111111111111111111111";
      const wipSha = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
      const backend = fakeWorkspaceBackend({
        listBranches: async () => [
          { name: "main", commit: { id: mainSha, url: `http://backend.invalid/owner/w/commit/${mainSha}` } },
          { name: "agent/wip", commit: { id: wipSha, url: `http://backend.invalid/owner/w/commit/${wipSha}` } },
        ],
      });
      const res = await localBranchAppFor(db, backend).request("/api/v1/repos/owner/w/branches");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        { name: "main", commit: { id: mainSha, url: `http://localhost/owner/w/commit/${mainSha}` } },
        { name: "agent/wip", commit: { id: wipSha, url: `http://localhost/owner/w/commit/${wipSha}` } },
      ]);
      expect(JSON.stringify(body)).not.toContain("backend.invalid");
    });

    it("GET /branches omits commit.url for a synthetic working-tree (WORKTREE) ref", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const backend = fakeWorkspaceBackend({
        listBranches: async () => [{ name: "main", commit: { id: "WORKTREE" } }],
      });
      const res = await localBranchAppFor(db, backend).request("/api/v1/repos/owner/w/branches");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([{ name: "main", commit: { id: "WORKTREE", url: "" } }]);
    });

    it("GET /branch_protections returns an empty list for tea branches", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "read");

      const res = await appFor(db).request("/api/v1/repos/owner/w/branch_protections", {
        headers: { authorization: `token ${token}` },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([]);
    });

    it("GET /branches/mine filters by head-commit author and excludes branches with open PRs", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const backend = fakeWorkspaceBackend({
        // Mix of authors. Includes a branch without the legacy user/<name>/
        // prefix to confirm we match on author, not name.
        listBranches: async () => [
          { name: "main", commit: { id: "m", author: { username: "alice" } } },
          {
            name: "user/alice/wip-1",
            commit: { id: "a1", timestamp: "2026-05-16T00:00:00Z", author: { username: "alice" } },
          },
          {
            name: "feature/docs",
            commit: { id: "a2", timestamp: "2026-05-16T00:01:00Z", author: { username: "alice" } },
          },
          { name: "user/test-bob/wip-9", commit: { id: "b9", author: { username: "test-bob" } } },
        ],
        listPulls: async () => [{ head: { ref: "user/alice/wip-1" }, base: { ref: "main" }, merged: false, state: "open" }],
      });
      const res = await localBranchAppFor(db, backend).request("/api/v1/repos/owner/w/branches/mine");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Array<{ name: string }> };
      // wip-1 excluded (open PR by alice), feature/docs kept (alice
      // authored, no PR), test-bob excluded (different author), main excluded
      // (also has no open-PR check but does have an unrelated commit shape).
      expect(body.branches.map((b) => b.name)).toEqual(["feature/docs"]);
    });

    it("POST /branches rejects names without a valid shape", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const res = await appFor(db).request("/api/v1/repos/owner/w/branches", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "../etc/passwd" }),
      });
      expect(res.status).toBe(400);
    });

    it("DELETE /branches/:name handles slash-containing names", async () => {
      const db = freshDb();
      seedWorkspace(db);
      let deletedBranch: string | null = null;
      const backend = fakeWorkspaceBackend({
        deleteBranch: async (_owner, _repo, branch) => {
          deletedBranch = branch;
        },
      });
      const res = await localBranchAppFor(db, backend).request("/api/v1/repos/owner/w/branches/user/alice/wip-2", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(deletedBranch).toBe("user/alice/wip-2");
    });

    it("DELETE /branches/:name propagates backend delete failures", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const backend = fakeWorkspaceBackend({
        deleteBranch: async () => {
          throw new WorkspaceBackendError(500, "error", "backend down");
        },
      });

      const res = await localBranchAppFor(db, backend).request("/api/v1/repos/owner/w/branches/user/alice/wip-2", { method: "DELETE" });

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("\"ok\":true");
    });

    it("DELETE /branches refuses main and invalid name shapes", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // Single-segment "main" and a space-containing name are both rejected
      // by the route's validation (400). Path-traversal forms with `..` are
      // resolved by the URL parser before the route handler sees them, so
      // we don't separately assert on them.
      for (const bad of ["main", "a%20b", "user/foo..bar"]) {
        const res = await appFor(db).request(
          `/api/v1/repos/owner/w/branches/${bad}`,
          { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        );
        expect(res.status, `expected 400 for ${bad}`).toBe(400);
      }
    });
  });

  describe("approvals math", () => {
    it("GET /pulls/:n/reviews counts the latest verdict per user", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // Vera REQUEST_CHANGES then APPROVE → 1 approval, 0 rejections.
      // Meri APPROVE alone → +1 approval.
      // Bob COMMENT only → no count.
      fetchMock
        .mockResolvedValueOnce(
          ok([
            { id: 1, state: "REQUEST_CHANGES", body: "", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:00:00Z" },
            { id: 2, state: "APPROVED", body: "lgtm", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:01:00Z" },
            { id: 3, state: "APPROVED", body: "", user: { login: "test-meri" }, submitted_at: "2026-05-16T00:02:00Z" },
            { id: 4, state: "COMMENT", body: "q", user: { login: "test-bob" }, submitted_at: "2026-05-16T00:03:00Z" },
          ]),
        )
        // approvalCounts uses listReviews — same data. Reused under the hood;
        // implementation calls it twice (once for output, once for counts).
        .mockResolvedValueOnce(
          ok([
            { id: 1, state: "REQUEST_CHANGES", body: "", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:00:00Z" },
            { id: 2, state: "APPROVED", body: "lgtm", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:01:00Z" },
            { id: 3, state: "APPROVED", body: "", user: { login: "test-meri" }, submitted_at: "2026-05-16T00:02:00Z" },
            { id: 4, state: "COMMENT", body: "q", user: { login: "test-bob" }, submitted_at: "2026-05-16T00:03:00Z" },
          ]),
        );
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        approvals: number;
        rejections: number;
        reviews: Array<{ id: number; username: string; decision: string }>;
      };
      expect(body.approvals).toBe(2);
      expect(body.rejections).toBe(0);
      expect(body.reviews.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(body.reviews.find((r) => r.username === "test-bob")?.decision).toBe("comment");
    });

    it("DISMISSED invalidates an earlier APPROVED from the same user (#56)", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const reviews = [
        { id: 1, state: "APPROVED", body: "lgtm", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:00:00Z" },
        { id: 2, state: "DISMISSED", body: "", user: { login: "test-vera" }, submitted_at: "2026-05-16T00:01:00Z" },
      ];
      fetchMock
        .mockResolvedValueOnce(ok(reviews))
        .mockResolvedValueOnce(ok(reviews));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { approvals: number; rejections: number };
      expect(body.approvals).toBe(0);
      expect(body.rejections).toBe(0);
    });

    // The typed reviews list must surface the CALLER'S OWN pending draft (as
    // decision "pending") so the staged pending-review flow round-trips through
    // the Origin client in the local Workbench — while still hiding other users'
    // drafts. The caller here is "alice".
    it("GET /pulls/:n/reviews includes the caller's own pending review but hides others'", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const reviews = [
        { id: 1, state: "APPROVED", body: "lgtm", user: { login: "vera" }, submitted_at: "2026-05-16T00:00:00Z" },
        { id: 2, state: "PENDING", body: "", user: { login: "alice" }, submitted_at: "2026-05-16T00:01:00Z" },
        { id: 3, state: "PENDING", body: "", user: { login: "mallory" }, submitted_at: "2026-05-16T00:02:00Z" },
      ];
      fetchMock.mockResolvedValueOnce(ok(reviews)).mockResolvedValueOnce(ok(reviews));
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/reviews", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reviews: Array<{ id: number; username: string; decision: string }> };
      expect(body.reviews.find((r) => r.id === 2)).toMatchObject({ username: "alice", decision: "pending" });
      // Other users' pending drafts stay hidden; submitted verdicts pass through.
      expect(body.reviews.find((r) => r.id === 3)).toBeUndefined();
      expect(body.reviews.find((r) => r.id === 1)).toMatchObject({ decision: "approve" });
    });
  });

  describe("line comments", () => {
    it("does not hide Forgejo failures as an empty comments list", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(new Response("forgejo down", { status: 503 }))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("\"comments\":[]");
    });

    it("does not hide per-review comment failures in the aggregate fallback", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(new Response("not found", { status: 404 })) // aggregate comments endpoint absent
        .mockResolvedValueOnce(ok([])) // files
        .mockResolvedValueOnce(ok([{ id: 11, state: "COMMENT", body: "", user: { login: "test-bob" } }])) // reviews
        .mockResolvedValueOnce(new Response("forgejo down", { status: 503 })); // per-review comments

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("\"comments\":[]");
    });

    it("edits only comments that belong to the requested pull request", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      let editedBody: unknown = null;
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json({ number: 7, state: "open", merged: false, head: { ref: "head" }, base: { ref: "main" }, labels: [] }));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/7", body: "note", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.patch("/api/v1/repos/owner/w/issues/comments/123", async (c) => {
          editedBody = await c.req.json();
          return Response.json({ id: 123, body: "updated" });
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments/123", {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "updated" }),
      });

      expect(res.status).toBe(200);
      expect(editedBody).toEqual({ body: "updated" });
    });

    it("rejects editing a comment that is not on the requested pull request", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      let edited = false;
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json({ number: 7, state: "open", merged: false, head: { ref: "head" }, base: { ref: "main" }, labels: [] }));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/8", body: "note", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.patch("/api/v1/repos/owner/w/issues/comments/123", () => {
          edited = true;
          return Response.json({ id: 123, body: "updated" });
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments/123", {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "updated" }),
      });

      expect(res.status).toBe(404);
      expect(edited).toBe(false);
    });

    it("deletes only comments whose review id matches the requested pull request comment", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      let deleted = false;
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json({ number: 7, state: "open", merged: false, head: { ref: "head" }, base: { ref: "main" }, labels: [] }));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/7", body: "note", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.delete("/api/v1/repos/owner/w/pulls/7/reviews/9/comments/123", () => {
          deleted = true;
          return new Response(null, { status: 204 });
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments/123?review_id=9", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(deleted).toBe(true);
    });

    it("rejects deleting a comment when the review id does not match", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const deleted = false;
      fetchMock.mockImplementation(fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json({ number: 7, state: "open", merged: false, head: { ref: "head" }, base: { ref: "main" }, labels: [] }));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/7", body: "note", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.delete("/api/v1/repos/owner/w/pulls/7/reviews/11/comments/123", () => {
          return new Response(null, { status: 404 });
        });
      }));

      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/comments/123?review_id=11", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(404);
      expect(deleted).toBe(false);
    });
  });
});

describe("POST /pulls duplicate-PR resolution (#181)", () => {
  it("rejects invalid head/base branch names before calling Forgejo", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const invalidHead = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers,
      body: JSON.stringify({ head: "bad..head", base: "main", title: "x" }),
    });
    const invalidBase = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers,
      body: JSON.stringify({ head: "user/alice/wip", base: "../main", title: "x" }),
    });
    const numericHead = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers,
      body: JSON.stringify({ head: 123, base: "main", title: "x" }),
    });
    const numericBase = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers,
      body: JSON.stringify({ head: "user/alice/wip", base: 123, title: "x" }),
    });

    expect(invalidHead.status).toBe(400);
    await expect(invalidHead.json()).resolves.toMatchObject({ error: "valid head branch name required" });
    expect(invalidBase.status).toBe(400);
    await expect(invalidBase.json()).resolves.toMatchObject({ error: "valid base branch name required" });
    expect(numericHead.status).toBe(400);
    await expect(numericHead.json()).resolves.toMatchObject({ error: "valid head branch name required" });
    expect(numericBase.status).toBe(400);
    await expect(numericBase.json()).resolves.toMatchObject({ error: "valid base branch name required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed optional PR title/body before calling Forgejo", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    for (const payload of [
      { head: "user/alice/wip", base: "main", title: { text: "bad" } },
      { head: "user/alice/wip", base: "main", body: { text: "bad" } },
    ]) {
      const res = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the existing open PR when one already exists for this head→base", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    let created = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/repos/owner/w/pulls", (c) => {
          created = true;
          return c.text("pull request already exists", 409 as 200);
        });
        forge.get("/api/v1/repos/owner/w/pulls", (c) =>
          c.json([
            pull({ number: 3, head: { ref: "other/branch", sha: "x" } }),
            pull({ number: 12, head: { ref: "user/alice/wip", sha: "h" }, base: { ref: "main", sha: "b" } }),
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ head: "user/alice/wip", base: "main", title: "x" }),
    });

    expect(created).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ number: 12 });
  });

  it("passes a 409 through as a conflict when no open PR matches (e.g. empty diff)", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/repos/owner/w/pulls", (c) => c.text("no diff between head and base", 409 as 200));
        forge.get("/api/v1/repos/owner/w/pulls", (c) => c.json([]));
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ head: "user/alice/wip", base: "main", title: "x" }),
    });

    expect(res.status).toBe(409);
  });

  it("GET /pulls/:n/commits returns stable Cosheaf commit DTOs", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7/commits", (c) =>
          c.json([
            {
              sha: "abc123",
              commit: { message: "first commit", author: { name: "Alice", email: "a@x", date: "2026-05-16T00:00:00Z" } },
              author: { login: "alice" },
            },
            {
              sha: "def456",
              commit: { message: "second commit", author: { name: "Nobody", email: "n@x", date: "2026-05-17T00:00:00Z" } },
              author: null,
            },
          ]),
        );
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/pulls/7/commits", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      commits: [
        { sha: "abc123", message: "first commit", author_username: "alice", author_name: "Alice", date: Date.parse("2026-05-16T00:00:00Z") },
        { sha: "def456", message: "second commit", author_username: null, author_name: "Nobody", date: Date.parse("2026-05-17T00:00:00Z") },
      ],
    });
  });

  it("GET /collaborators returns logins with resolved permissions", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "admin");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/collaborators", (c) => c.json([{ login: "alice" }, { login: "bob" }]));
        forge.get("/api/v1/repos/owner/w/collaborators/alice/permission", (c) => c.json({ permission: "admin" }));
        forge.get("/api/v1/repos/owner/w/collaborators/bob/permission", (c) => c.json({ permission: "write" }));
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/collaborators", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      collaborators: [
        { login: "alice", permission: "admin" },
        { login: "bob", permission: "write" },
      ],
    });
  });

  it("GET /collaborators degrades an unreadable permission to null", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/collaborators", (c) => c.json([{ login: "bob" }]));
        forge.get("/api/v1/repos/owner/w/collaborators/bob/permission", (c) => c.text("forbidden", 403 as 200));
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/collaborators", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ collaborators: [{ login: "bob", permission: null }] });
  });

  it("GET /topics returns the repo topics", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/topics", (c) => c.json({ topics: ["cosheaf-format-coflat", "math"] }));
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/topics", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ topics: ["cosheaf-format-coflat", "math"] });
  });

  it("PUT /topics replaces the topic set for an admin", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "admin");
    let replaced: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/collaborators/alice/permission", (c) => c.json({ permission: "admin" }));
        forge.put("/api/v1/repos/owner/w/topics", async (c) => {
          replaced = await c.req.json();
          return c.body(null, 204);
        });
      }),
    );

    const res = await appFor(db).request("/api/v1/repos/owner/w/topics", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ topics: ["cosheaf-format-coflat", "math"] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(replaced).toEqual({ topics: ["cosheaf-format-coflat", "math"] });
  });

  it("PUT /topics rejects a write user with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok({ permission: "write" }));
    const res = await appFor(db).request("/api/v1/repos/owner/w/topics", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ topics: ["math"] }),
    });
    expect(res.status).toBe(403);
  });

  it("PUT /topics rejects a non-string-array payload", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "admin");
    fetchMock.mockResolvedValueOnce(ok({ permission: "admin" }));
    const res = await appFor(db).request("/api/v1/repos/owner/w/topics", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ topics: [1, 2] }),
    });
    expect(res.status).toBe(400);
  });
});
