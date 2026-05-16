import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { ForgejoError, type Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { changes } from "./changes.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-pulls-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
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
  db.prepare("INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, 'test', ?, 0)")
    .run(id, sha256Hex(token));
  db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (1, ?, ?)").run(id, role);
  return token;
}

function seedWorkspace(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
  ).run();
}

function seedChange(
  db: Database.Database,
  id: string,
  authorId: number,
  prNumber: number | null,
  state: string,
): void {
  db.prepare(
    "INSERT INTO branches (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
      "VALUES (?, 1, ?, ?, ?, ?, 0, 0)",
  ).run(id, authorId, `change/${id}`, state, prNumber);
}

function fakeForgejo(overrides: Partial<Forgejo> = {}): Forgejo {
  return {
    createReview: vi.fn(async () => ({ id: 1, body: "", state: "APPROVED", user: { id: 1, login: "cs-user" } })),
    listReviews: vi.fn(async () => []),
    getBranchProtection: vi.fn(async () => ({ required_approvals: 1 })),
    mergePull: vi.fn(async () => undefined),
    editPull: vi.fn(async () => ({ number: 5 })),
    deleteBranch: vi.fn(async () => undefined),
    getPull: vi.fn(async () => ({
      id: 1,
      number: 7,
      title: "Add a thing",
      body: "cosheaf-change-id: abc",
      state: "open",
      merged: false,
      mergeable: true,
      additions: 5,
      deletions: 2,
      changed_files: 1,
      head: { ref: "change/abc", sha: "head-sha", label: "" },
      base: { ref: "main", sha: "base-sha" },
      user: { id: 9, login: "cs-author" },
      created_at: "2026-05-12T00:00:00Z",
      updated_at: "2026-05-12T01:00:00Z",
    })),
    listPullFiles: vi.fn(async () => [
      { filename: "hello.md", status: "modified", additions: 2, deletions: 1, changes: 3 },
      { filename: "new.md", status: "added", additions: 3, deletions: 0, changes: 3 },
    ]),
    getPullDiff: vi.fn(
      async () =>
        [
          "diff --git a/hello.md b/hello.md",
          "--- a/hello.md",
          "+++ b/hello.md",
          "@@ -1,2 +1,3 @@",
          " context",
          "-old",
          "+new",
          "+added",
          "diff --git a/new.md b/new.md",
          "--- /dev/null",
          "+++ b/new.md",
          "@@ -0,0 +1,3 @@",
          "+a",
          "+b",
          "+c",
          "",
        ].join("\n"),
    ),
    getRawFile: vi.fn(async (_o: string, _r: string, ref: string, filePath: string) => {
      throw new ForgejoError(404, "not found", "GET", `/${ref}/${filePath}`);
    }),
    ...overrides,
  } as unknown as Forgejo;
}

function appFor(db: Database.Database, forgejo: Forgejo): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("forgejo", forgejo);
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", changes);
  return app;
}

describe("Forgejo-shape /pulls endpoints", () => {
  it("POST /pulls/:n/reviews { event: APPROVE } mirrors /branch/:id/approve", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 7, "review");
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/pulls/7/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "APPROVE", body: "lgtm" }),
    });

    expect(res.status).toBe(200);
    expect(forgejo.createReview).toHaveBeenCalledWith("owner", "repo", 7, {
      event: "APPROVED",
      body: "lgtm",
      sudo: "cs-vera",
    });
    // Without enough APPROVED reviews in listReviews, the change stays in
    // review (same as POST /branch/:id/approve would in this fixture).
    expect(db.prepare("SELECT state FROM branches WHERE id = 'abc'").get()).toEqual({ state: "review" });
  });

  it("POST /pulls/:n/reviews { event: APPROVE } produces the same DB state as /branch/:id/approve", async () => {
    const setup = (): { db: Database.Database; app: Hono<AppEnv>; verifier: string } => {
      const db = freshDb();
      seedWorkspace(db);
      seedUser(db, 1, "alice", "member");
      const verifier = seedUser(db, 2, "vera", "verifier");
      seedChange(db, "abc", 1, 7, "review");
      const forgejo = fakeForgejo({
        listReviews: vi.fn(async () => [
          { id: 1, state: "APPROVED", body: "ok", user: { id: 2, login: "cs-vera" }, submitted_at: "2026-05-12T00:00:00Z" },
        ]),
      } as Partial<Forgejo>);
      return { db, app: appFor(db, forgejo), verifier };
    };

    const a = setup();
    const r1 = await a.app.request("/api/v1/w/w/branch/abc/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${a.verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "ok" }),
    });
    expect(r1.status).toBe(200);
    const oldState = a.db.prepare("SELECT state FROM branches WHERE id = 'abc'").get();

    const b = setup();
    const r2 = await b.app.request("/api/v1/w/w/pulls/7/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${b.verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "APPROVE", body: "ok" }),
    });
    expect(r2.status).toBe(200);
    const newState = b.db.prepare("SELECT state FROM branches WHERE id = 'abc'").get();
    expect(newState).toEqual(oldState);
  });

  it("POST /pulls/:n/reviews { event: REQUEST_CHANGES } mirrors /branch/:id/request-changes", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 9, "review");
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/pulls/9/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "REQUEST_CHANGES", body: "please repair" }),
    });

    expect(res.status).toBe(200);
    expect(forgejo.createReview).toHaveBeenCalledWith("owner", "repo", 9, {
      event: "REQUEST_CHANGES",
      body: "please repair",
      sudo: "cs-vera",
    });
    expect(db.prepare("SELECT state FROM branches WHERE id = 'abc'").get()).toEqual({
      state: "changes_requested",
    });
  });

  it("POST /pulls/:n/reviews { event: COMMENT } mirrors /branch/:id/comment", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 11, "review");
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/pulls/11/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "COMMENT", body: "drive-by note" }),
    });

    expect(res.status).toBe(200);
    expect(forgejo.createReview).toHaveBeenCalledWith("owner", "repo", 11, {
      event: "COMMENT",
      body: "drive-by note",
      sudo: "cs-vera",
    });
    // state unchanged
    expect(db.prepare("SELECT state FROM branches WHERE id = 'abc'").get()).toEqual({ state: "review" });
  });

  it("POST /pulls/:n/reviews rejects unknown event", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 7, "review");
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/pulls/7/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "approve", body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /pulls/:n/reviews returns same shape as /branch/:id/approvals", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 13, "review");
    const forgejo = fakeForgejo({
      listReviews: vi.fn(async () => [
        {
          id: 100,
          state: "APPROVED",
          body: "ok",
          user: { id: 2, login: "cs-vera" },
          submitted_at: "2026-05-12T00:00:00Z",
        },
      ]),
    } as Partial<Forgejo>);
    const verifier = "cs_vera";
    const app = appFor(db, forgejo);

    const newShape = await app.request("/api/v1/w/w/pulls/13/reviews", {
      headers: { authorization: `Bearer ${verifier}` },
    });
    expect(newShape.status).toBe(200);
    const oldShape = await app.request("/api/v1/w/w/branch/abc/approvals", {
      headers: { authorization: `Bearer ${verifier}` },
    });
    expect(oldShape.status).toBe(200);
    expect(await newShape.json()).toEqual(await oldShape.json());
  });

  it("GET /pulls/:n returns Forgejo PR object plus cosheaf extras", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 7, "review");
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/pulls/7", {
      headers: { authorization: "Bearer cs_vera" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Raw Forgejo shape
    expect(body.number).toBe(7);
    expect(body.title).toBe("Add a thing");
    expect(body.head).toMatchObject({ sha: "head-sha" });
    expect(body.base).toMatchObject({ sha: "base-sha" });
    // Cosheaf extras
    expect(body.cosheaf_state).toBe("review");
    expect(body.author_user_id).toBe(1);
    expect(body.author_username).toBe("cs-author");
    expect(body.head_sha).toBe("head-sha");
    expect(body.base_sha).toBe("base-sha");
    expect(body.additions_total).toBe(5);
    expect(body.deletions_total).toBe(2);
    expect(body.files_changed).toBe(1);
  });

  it("GET /pulls/:n/files returns the same per-file shape as /branch/:id/diff", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 7, "review");
    const app = appFor(db, fakeForgejo());

    const newShape = await app.request("/api/v1/w/w/pulls/7/files", {
      headers: { authorization: "Bearer cs_vera" },
    });
    expect(newShape.status).toBe(200);
    const oldShape = await app.request("/api/v1/w/w/branch/abc/diff", {
      headers: { authorization: "Bearer cs_vera" },
    });
    expect(oldShape.status).toBe(200);
    const newBody = (await newShape.json()) as { files: unknown[] };
    const oldBody = (await oldShape.json()) as { files: unknown[] };
    expect(newBody.files).toEqual(oldBody.files);
    expect(newBody.files).toHaveLength(2);
  });

  it("GET /pulls?state=open returns the same data as /branches/open", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "abc", 1, 7, "review");
    seedChange(db, "def", 1, 8, "changes_requested");
    seedChange(db, "ghi", 1, 9, "merged");
    const app = appFor(db, fakeForgejo());

    const pulls = await app.request("/api/v1/w/w/pulls?state=open", {
      headers: { authorization: `Bearer ${verifier}` },
    });
    expect(pulls.status).toBe(200);
    const pullsBody = (await pulls.json()) as { changes: Array<{ id: string }> };
    const branchesOpen = await app.request("/api/v1/w/w/branches/open", {
      headers: { authorization: `Bearer ${verifier}` },
    });
    expect(branchesOpen.status).toBe(200);
    const branchesBody = (await branchesOpen.json()) as { changes: Array<{ id: string }> };
    expect(pullsBody.changes.map((c) => c.id).sort()).toEqual(
      branchesBody.changes.map((c) => c.id).sort(),
    );
    expect(pullsBody.changes.map((c) => c.id).sort()).toEqual(["abc", "def"]);
  });

  it("GET /pulls?state=closed returns merged and closed changes", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    seedChange(db, "open1", 1, 1, "review");
    seedChange(db, "m1", 1, 2, "merged");
    seedChange(db, "c1", 1, 3, "closed");
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/pulls?state=closed", {
      headers: { authorization: `Bearer ${verifier}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: Array<{ id: string }> };
    expect(body.changes.map((c) => c.id).sort()).toEqual(["c1", "m1"]);
  });

  it("returns 404 when the PR number does not correspond to a known change", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifier = seedUser(db, 2, "vera", "verifier");
    const app = appFor(db, fakeForgejo());

    for (const path of [
      "/api/v1/w/w/pulls/999",
      "/api/v1/w/w/pulls/999/files",
      "/api/v1/w/w/pulls/999/reviews",
    ]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${verifier}` } });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not found", code: "not_found" });
    }

    const postRes = await app.request("/api/v1/w/w/pulls/999/reviews", {
      method: "POST",
      headers: { authorization: `Bearer ${verifier}`, "content-type": "application/json" },
      body: JSON.stringify({ event: "APPROVE", body: null }),
    });
    expect(postRes.status).toBe(404);
  });
});
