// Route-level tests for the new Forgejo-shape /pulls/* and /branches/*
// endpoints. The Forgejo client is real; `fetch` is mocked. The
// permission cache is pre-seeded per test so we exercise only the
// request actually under test against the mock.

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
import { _resetPermCacheForTests, _seedPermCacheForTests } from "../middleware.js";
import { pulls } from "./pulls.js";
import { branches } from "./branches.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-pulls-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-pulls-"));
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
    c.set("forgejo", new Forgejo({ baseUrl: config.forgejoUrl, adminToken: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", pulls);
  app.route("/api/v1/w", branches);
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

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function empty(status = 200): Response {
  // 204/304 are null-body statuses — fetch's Response constructor refuses
  // non-null bodies, so emit a true null body for them.
  if (status === 204 || status === 304) {
    return new Response(null, { status });
  }
  return new Response("", { status });
}
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
    user: { login: "cs-alice" },
    head: { ref: "user/cs-alice/wip", sha: "h" },
    base: { ref: "main", sha: "b" },
    ...overrides,
  };
}

describe("pulls + branches routes", () => {
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
  });

  describe("write+ gates", () => {
    it("POST /pulls/:n/reviews rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "bob", "read");
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
      const token = seedUser(db, 1, "bob", "read");
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/close", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("POST /pulls/:n/comments rejects a read user with 403", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "bob", "read");
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/comments", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "x.md", line: 1, side: "new", body: "hi" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("self-review block", () => {
    it("POST /pulls/:n/reviews returns 403 when the PR is the caller's", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      // GET /pulls/7 → returns a PR authored by cs-alice (the caller).
      fetchMock.mockResolvedValueOnce(ok(pull({ user: { login: "cs-alice" } })));
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

  describe("merge with retry", () => {
    it("POST /pulls/:n/merge retries on Forgejo 405 'try again later' and eventually succeeds", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "admin");
      fetchMock
        .mockResolvedValueOnce(ok({ permission: "admin" })) // requireAdminFresh
        .mockResolvedValueOnce(new Response("Please try again later", { status: 405 }))
        .mockResolvedValueOnce(empty(200)) // merge succeeds
        .mockResolvedValueOnce(ok(pull({ head: { ref: "user/cs-alice/wip", sha: "h" } }))) // GET pull
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
    it("GET /branches/mine filters by `user/<sudo>/` prefix and excludes branches with open PRs", async () => {
      const db = freshDb();
      seedWorkspace(db);
      const token = seedUser(db, 1, "alice", "write");
      fetchMock
        // listBranches paged: first page returns 4, second page returns 0
        .mockResolvedValueOnce(
          ok([
            { name: "main", commit: { id: "m" } },
            { name: "user/cs-alice/wip-1", commit: { id: "a1", timestamp: "2026-05-16T00:00:00Z" } },
            { name: "user/cs-alice/wip-2", commit: { id: "a2", timestamp: "2026-05-16T00:01:00Z" } },
            { name: "user/cs-bob/wip-9", commit: { id: "b9" } },
          ]),
        )
        // listPulls "open"
        .mockResolvedValueOnce(ok([pull({ head: { ref: "user/cs-alice/wip-1", sha: "h" } })]));
      const res = await appFor(db).request("/api/v1/w/w/branches/mine", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Array<{ name: string }> };
      // wip-1 excluded (open PR), wip-2 kept, bob excluded (wrong prefix).
      expect(body.branches.map((b) => b.name)).toEqual(["user/cs-alice/wip-2"]);
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
            { id: 1, state: "REQUEST_CHANGES", body: "", user: { login: "cs-vera" }, submitted_at: "2026-05-16T00:00:00Z" },
            { id: 2, state: "APPROVED", body: "lgtm", user: { login: "cs-vera" }, submitted_at: "2026-05-16T00:01:00Z" },
            { id: 3, state: "APPROVED", body: "", user: { login: "cs-meri" }, submitted_at: "2026-05-16T00:02:00Z" },
            { id: 4, state: "COMMENT", body: "q", user: { login: "cs-bob" }, submitted_at: "2026-05-16T00:03:00Z" },
          ]),
        )
        // approvalCounts uses listReviews — same data. Reused under the hood;
        // implementation calls it twice (once for output, once for counts).
        .mockResolvedValueOnce(
          ok([
            { id: 1, state: "REQUEST_CHANGES", body: "", user: { login: "cs-vera" }, submitted_at: "2026-05-16T00:00:00Z" },
            { id: 2, state: "APPROVED", body: "lgtm", user: { login: "cs-vera" }, submitted_at: "2026-05-16T00:01:00Z" },
            { id: 3, state: "APPROVED", body: "", user: { login: "cs-meri" }, submitted_at: "2026-05-16T00:02:00Z" },
            { id: 4, state: "COMMENT", body: "q", user: { login: "cs-bob" }, submitted_at: "2026-05-16T00:03:00Z" },
          ]),
        );
      const res = await appFor(db).request("/api/v1/w/w/pulls/7/reviews", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        approvals: number;
        rejections: number;
        reviews: Array<{ username: string; decision: string }>;
      };
      expect(body.approvals).toBe(2);
      expect(body.rejections).toBe(0);
      expect(body.reviews.find((r) => r.username === "cs-bob")?.decision).toBe("comment");
    });
  });
});
