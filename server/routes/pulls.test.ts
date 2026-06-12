// Route-level tests for the typed /pulls/* and /branches/* endpoints. The
// Forgejo client is real; `fetch` is mocked. The
// permission cache is pre-seeded per test so we exercise only the
// request actually under test against the mock.

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { _resetBearerAuthCacheForTests, _resetFormatCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import { pulls } from "./pulls.js";
import { branches } from "./branches.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { freshTestDb, responseEmpty as empty, responseOk as ok, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

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
    app.route("/api/v1/w", pulls);
    app.route("/api/v1/w", branches);
  });
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

describe("pulls + branches routes", () => {
  it("GET /pulls returns stable Cosheaf PR metadata", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([
      pull({ number: 8, title: "Update docs", head: { ref: "agent/wip", sha: "h8" } }),
    ]));

    const res = await appFor(db).request("/api/v1/w/w/pulls?state=all", {
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

  it("GET /pulls maps Forgejo-native filters", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request(
      "/api/v1/w/w/pulls?state=all&labels=4&milestone=2&author=test-meri&sort=oldest",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("labels")).toBe("4");
    expect(url.searchParams.get("milestone")).toBe("2");
    expect(url.searchParams.get("poster")).toBe("test-meri");
    expect(url.searchParams.get("sort")).toBe("oldest");
  });

  it("GET /pulls/:n returns stable Cosheaf PR metadata", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok(pull({ number: 7, title: "Review me" })));

    const res = await appFor(db).request("/api/v1/w/w/pulls/7", {
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

    const res = await appFor(db).request("/api/v1/w/w/pulls/7", {
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

    const res = await appFor(db).request("/api/v1/w/w/pulls/7/labels", {
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

    const res = await appFor(db).request("/api/v1/w/w/pulls/7/labels", {
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

    const res = await appFor(db).request("/api/v1/w/w/pulls/7/labels", {
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
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/merge", {
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
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/merge", {
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
      const res = await appFor(db).request("/api/v1/w/w/settings", {
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
      const res = await appFor(db).request("/api/v1/w/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ default_md_format: "unknown" }),
      });
      expect(res.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("PUT /settings writes the format topic to Forgejo before reindex", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      // Sequence: requireAdminFresh → getBranchProtection → listRepoTopics →
      // replaceRepoTopics → getTree (fails). The format topic write is the
      // commit point; the reindex is best-effort.
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" }))
        .mockResolvedValueOnce(ok({ branch_name: "main", required_approvals: 1 }))
        .mockResolvedValueOnce(ok({ topics: [] }))
        .mockResolvedValueOnce(empty(204))
        .mockResolvedValueOnce(ok({ message: "tree failed" }, 500));

      const res = await appFor(db).request("/api/v1/w/w/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ default_md_format: COFLAT_FORMAT_ID }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { code: string; step?: string };
      expect(body.code).toBe("reindex_failed");
      expect(body.step).toBe("reindex");
      // Assert the Forgejo topics PUT was called with the new format topic.
      // (No SQLite UPDATE to verify — workspaces table is gone in #62.)
      const topicsPutCall = fetchMock.mock.calls.find((call) => {
        const url = String(call[0] ?? "");
        const init = (call[1] ?? {}) as RequestInit;
        return url.includes("/repos/owner/w/topics") && (init.method ?? "GET").toUpperCase() === "PUT";
      });
      expect(topicsPutCall, "Forgejo /topics PUT was not called").toBeDefined();
      const reqInit = (topicsPutCall?.[1] ?? {}) as RequestInit;
      const sentBody = JSON.parse(String(reqInit.body ?? "{}")) as { topics?: string[] };
      expect(sentBody.topics).toEqual(expect.arrayContaining([`cosheaf-format-${COFLAT_FORMAT_ID}`]));
    });
  });

  describe("write+ gates", () => {
    it("POST /pulls/:n/reviews rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/close rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/close", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/comments rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "test-bob", "read");
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/comments", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "x.md", line: 1, side: "head", body: "hi" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/comments rejects bad shapes before reaching Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const post = (body: unknown) =>
        appFor(db).request("/api/v1/w/w/pulls/42/comments", {
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

      const res = await appFor(db).request("/api/v1/w/w/pulls/7/review-requests", {
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

      const res = await appFor(db).request("/api/v1/w/w/pulls/7/review-requests", {
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

    it("DELETE /pulls/:n/review-requests cancels reviewers through Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        .mockResolvedValueOnce(empty(204))
        .mockResolvedValueOnce(ok(pull({ requested_reviewers: [] })));

      const res = await appFor(db).request("/api/v1/w/w/pulls/7/review-requests", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reviewers: ["test-vera"] }),
      });

      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewers: ["test-vera"] });
    });
  });

  describe("self-review block", () => {
    it("POST /pulls/:n/reviews returns 403 when the PR is the caller's", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // GET /pulls/7 → returns a PR authored by alice (the caller).
      fetchMock.mockResolvedValueOnce(ok(pull({ user: { login: "alice" } })));
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/own pull request/);
    });
  });

  describe("pending review ids", () => {
    it("rejects fractional pending review ids before calling Forgejo", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const submit = await appFor(db).request("/api/v1/w/w/pulls/7/pending-review/1.5/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ event: "approve" }),
      });
      const comment = await appFor(db).request("/api/v1/w/w/pulls/7/pending-review/1.5/comments", {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "x.md", line: 1, side: "head", body: "hi" }),
      });

      expect(submit.status).toBe(400);
      expect(comment.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("merge with retry", () => {
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
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(200);
      // 405 + retry + getPull + deleteBranch + (admin-fresh perm) = 5 fetches
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("POST /pulls/:n/merge returns 409 on non-retryable Forgejo errors", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("PR has merge conflicts", { status: 405 }));
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/merge", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("branches", () => {
    it("GET /branches/mine filters by head-commit author and excludes branches with open PRs", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        // listBranches: mix of authors. Includes a branch without the legacy
        // user/<name>/ prefix to confirm we now match on author, not name.
        .mockResolvedValueOnce(
          ok([
            { name: "main", commit: { id: "m", author: { username: "alice" } } },
            {
              name: "user/alice/wip-1",
              commit: { id: "a1", timestamp: "2026-05-16T00:00:00Z", author: { username: "alice" } },
            },
            {
              name: "feature/passthrough",
              commit: { id: "a2", timestamp: "2026-05-16T00:01:00Z", author: { username: "alice" } },
            },
            { name: "user/test-bob/wip-9", commit: { id: "b9", author: { username: "test-bob" } } },
          ]),
        )
        // listPulls "open"
        .mockResolvedValueOnce(ok([pull({ head: { ref: "user/alice/wip-1", sha: "h" } })]));
      const res = await appFor(db).request("/api/v1/w/w/branches/mine", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Array<{ name: string }> };
      // wip-1 excluded (open PR by alice), feature/passthrough kept (alice
      // authored, no PR), test-bob excluded (different author), main excluded
      // (also has no open-PR check but does have an unrelated commit shape).
      expect(body.branches.map((b) => b.name).sort()).toEqual(
        ["feature/passthrough", "main"].sort(),
      );
    });

    it("POST /branches rejects names without a valid shape", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      const res = await appFor(db).request("/api/v1/w/w/branches", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "../etc/passwd" }),
      });
      expect(res.status).toBe(400);
    });

    it("DELETE /branches/:name handles slash-containing names", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock.mockResolvedValueOnce(empty(204));
      const res = await appFor(db).request("/api/v1/w/w/branches/user/alice/wip-2", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      // Upstream Forgejo URL contains the full multi-segment name (URL-encoded
      // per Forgejo's API path-param convention).
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        "/branches/user%2Falice%2Fwip-2",
      );
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
          `/api/v1/w/w/branches/${bad}`,
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
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/reviews", {
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
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/reviews", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { approvals: number; rejections: number };
      expect(body.approvals).toBe(0);
      expect(body.rejections).toBe(0);
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

      const res = await appFor(db).request("/api/v1/w/w/pulls/7/comments", {
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
        .mockResolvedValueOnce(new Response("", { status: 200 })) // diff
        .mockResolvedValueOnce(ok([{ id: 11, state: "COMMENT", body: "", user: { login: "test-bob" } }])) // reviews
        .mockResolvedValueOnce(new Response("forgejo down", { status: 503 })); // per-review comments

      const res = await appFor(db).request("/api/v1/w/w/pulls/7/comments", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("\"comments\":[]");
    });
  });
});
