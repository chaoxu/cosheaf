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
import { files } from "./files.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-route-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-routes-"));
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
  db.prepare("INSERT INTO users (id, username, password_hash, forgejo_username, created_at) VALUES (?, ?, 'hash', ?, 0)")
    .run(id, username, `cs-${username}`);
  db.prepare("INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, 'test', ?, 0)")
    .run(id, sha256Hex(token));
  db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (1, ?, ?)")
    .run(id, role);
  return token;
}

function seedWorkspace(db: Database.Database): void {
  db.prepare("INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)").run();
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
  app.route("/api/v1/w", files);
  app.route("/api/v1/w", changes);
  return app;
}

function fakeForgejo(): Forgejo {
  const raw: Record<string, Record<string, string>> = {
    main: {
      "a.md": "# Main\n",
      ".gitattributes": "*.md text eol=lf -text\n",
    },
    "change/abc": {
      "a.md": "# Secret draft\n",
      ".gitattributes": "*.md text eol=lf -text\n",
    },
  };
  return {
    getRawFile: vi.fn(async (_owner: string, _repo: string, ref: string, filePath: string) => {
      const body = raw[ref]?.[filePath];
      if (body === undefined) throw Object.assign(new Error("not found"), { status: 404 });
      return body;
    }),
    getFileMeta: vi.fn(async (_owner: string, _repo: string, ref: string, filePath: string) => {
      if (raw[ref]?.[filePath] === undefined) return null;
      return { name: path.posix.basename(filePath), path: filePath, sha: `sha-${ref}-${filePath}`, size: raw[ref][filePath].length, type: "file" };
    }),
    putFile: vi.fn(async (_owner: string, _repo: string, opts: { branch: string; path: string; content: string }) => {
      raw[opts.branch] ??= { ...raw.main };
      raw[opts.branch][opts.path] = opts.content;
      return { commit: { sha: `commit-${opts.branch}-${opts.path}` } };
    }),
    deleteFile: vi.fn(async () => undefined),
    getBranch: vi.fn(async (_owner: string, _repo: string, branch: string) =>
      raw[branch] ? { name: branch, commit: { id: `sha-${branch}` } } : null,
    ),
    createBranch: vi.fn(async (_owner: string, _repo: string, opts: { newBranchName: string }) => {
      raw[opts.newBranchName] = { ...raw.main };
      return { name: opts.newBranchName, commit: { id: `sha-${opts.newBranchName}` } };
    }),
    createPull: vi.fn(async () => ({ number: 5 })),
    createReview: vi.fn(async () => ({ id: 1, body: "", state: "APPROVED", user: { id: 1, login: "cs-user" } })),
    listReviews: vi.fn(async () => []),
    getBranchProtection: vi.fn(async () => ({ required_approvals: 1 })),
    mergePull: vi.fn(async () => undefined),
    editPull: vi.fn(async () => ({ number: 5 })),
    deleteBranch: vi.fn(async () => undefined),
  } as unknown as Forgejo;
}

describe("route stability boundaries", () => {
  it("does not let another member read an explicit draft change branch", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const bobToken = seedUser(db, 2, "bob", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, created_at, updated_at) " +
        "VALUES ('abc', 1, 1, 'change/abc', 'draft', 0, 0)",
    ).run();
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/file?path=a.md&change_id=abc", {
      headers: { authorization: `Bearer ${bobToken}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ content: "# Main\n" });
  });

  it("rejects non-markdown deletes before touching Forgejo", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "owner");
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/file?path=.gitattributes", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    expect(forgejo.deleteFile).not.toHaveBeenCalled();
  });

  it("closes an empty draft publish instead of leaving a stale draft", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "owner");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, created_at, updated_at) " +
        "VALUES ('empty', 1, 1, 'change/empty', 'draft', 0, 0)",
    ).run();
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ change_id: "empty", mode: "direct" }),
    });

    expect(res.status).toBe(200);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'empty'").get()).toEqual({ state: "closed" });
  });

  it("rejects non-owner self-review", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "verifier");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('self', 1, 1, 'change/self', 'review', 7, 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/branch/self/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "looks good to me" }),
    });

    expect(res.status).toBe(403);
    expect(forgejo.createReview).not.toHaveBeenCalled();
  });

  it("request-changes keeps the PR branch open for author repair", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifierToken = seedUser(db, 2, "vera", "verifier");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('needs-work', 1, 1, 'change/needs-work', 'review', 9, 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/branch/needs-work/request-changes", {
      method: "POST",
      headers: { authorization: `Bearer ${verifierToken}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "please repair" }),
    });

    expect(res.status).toBe(200);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'needs-work'").get()).toEqual({ state: "changes_requested" });
    expect(forgejo.createReview).toHaveBeenCalledWith("owner", "repo", 9, {
      event: "REQUEST_CHANGES",
      body: "please repair",
      sudo: "cs-vera",
    });
    expect(forgejo.editPull).not.toHaveBeenCalled();
    expect(forgejo.deleteBranch).not.toHaveBeenCalled();
  });

  it("retries transient Forgejo merge failures after approval", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifierToken = seedUser(db, 2, "vera", "verifier");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('approve-me', 1, 1, 'change/abc', 'review', 5, 0, 0)",
    ).run();
    const forgejo = fakeForgejo() as Forgejo & {
      listReviews: ReturnType<typeof vi.fn>;
      mergePull: ReturnType<typeof vi.fn>;
    };
    forgejo.listReviews.mockResolvedValue([
      { state: "APPROVED", body: "", user: { login: "cs-vera" }, submitted_at: "2026-05-11T00:00:00Z" },
    ]);
    for (let i = 0; i < 3; i++) {
      forgejo.mergePull.mockRejectedValueOnce(new ForgejoError(405, "Please try again later", "POST", "/merge"));
    }
    forgejo.mergePull.mockResolvedValueOnce(undefined);
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/branch/approve-me/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${verifierToken}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "ok" }),
    });

    expect(res.status).toBe(200);
    expect(forgejo.mergePull).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'approve-me'").get()).toEqual({ state: "merged" });
    expect(forgejo.deleteBranch).toHaveBeenCalledWith("owner", "repo", "change/abc");
  });

  it("records comment-only reviews without changing state", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifierToken = seedUser(db, 2, "vera", "verifier");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('comment-me', 1, 1, 'change/abc', 'review', 5, 0, 0)",
    ).run();
    const forgejo = fakeForgejo() as Forgejo & { listReviews: ReturnType<typeof vi.fn> };
    forgejo.listReviews.mockResolvedValue([
      { state: "COMMENT", body: "note only", user: { login: "cs-vera" }, submitted_at: "2026-05-11T00:00:00Z" },
    ]);
    const app = appFor(db, forgejo);

    const comment = await app.request("/api/v1/w/w/branch/comment-me/comment", {
      method: "POST",
      headers: { authorization: `Bearer ${verifierToken}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "note only" }),
    });
    expect(comment.status).toBe(200);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'comment-me'").get()).toEqual({ state: "review" });
    expect(forgejo.createReview).toHaveBeenCalledWith("owner", "repo", 5, {
      event: "COMMENT",
      body: "note only",
      sudo: "cs-vera",
    });

    const approvals = await app.request("/api/v1/w/w/branch/comment-me/approvals", {
      headers: { authorization: `Bearer ${verifierToken}` },
    });
    expect(await approvals.json()).toEqual({
      approvals: [
        {
          verifier_user_id: 2,
          username: "vera",
          decision: "comment",
          comment: "note only",
          created_at: Date.parse("2026-05-11T00:00:00Z"),
        },
      ],
    });
  });

  it("lets the author repair a changes_requested branch and publish it back to review", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const authorToken = seedUser(db, 1, "alice", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const write = await app.request("/api/v1/w/w/file?path=a.md&change_id=repair-me", {
      method: "PUT",
      headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Repaired\n" }),
    });
    expect(write.status).toBe(200);
    expect(forgejo.putFile).toHaveBeenCalled();

    const publish = await app.request("/api/v1/w/w/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ change_id: "repair-me", mode: "review" }),
    });
    expect(publish.status).toBe(200);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'repair-me'").get()).toEqual({ state: "review" });
    expect(forgejo.createPull).not.toHaveBeenCalled();
  });

  it("reuses a single changes_requested change for omitted change_id writes", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const authorToken = seedUser(db, 1, "alice", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const write = await app.request("/api/v1/w/w/file?path=a.md", {
      method: "PUT",
      headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Repaired implicitly\n" }),
    });

    expect(write.status).toBe(200);
    await expect(write.json()).resolves.toMatchObject({ change_id: "repair-me" });
    expect(forgejo.putFile).toHaveBeenCalledWith("owner", "repo", expect.objectContaining({
      branch: "change/abc",
      path: "a.md",
    }));
  });

  it("requires explicit change_id when draft and changes_requested writes are ambiguous", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const authorToken = seedUser(db, 1, "alice", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, created_at, updated_at) " +
        "VALUES ('draft-one', 1, 1, 'change/draft-one', 'draft', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 1, 1)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const write = await app.request("/api/v1/w/w/file?path=a.md", {
      method: "PUT",
      headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Ambiguous\n" }),
    });

    expect(write.status).toBe(400);
    await expect(write.json()).resolves.toMatchObject({ code: "ambiguous" });
    expect(forgejo.putFile).not.toHaveBeenCalled();
  });

  it("hides changes_requested branch contents from unrelated members", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const bobToken = seedUser(db, 2, "bob", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 0, 0)",
    ).run();
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/file?path=a.md&change_id=repair-me", {
      headers: { authorization: `Bearer ${bobToken}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ content: "# Main\n" });
  });

  it("does not let verifiers terminally close another author's change", async () => {
    const db = freshDb();
    seedWorkspace(db);
    seedUser(db, 1, "alice", "member");
    const verifierToken = seedUser(db, 2, "vera", "verifier");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
        "VALUES ('review-me', 1, 1, 'change/abc', 'review', 5, 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const res = await app.request("/api/v1/w/w/branch/review-me/close", {
      method: "POST",
      headers: { authorization: `Bearer ${verifierToken}` },
    });

    expect(res.status).toBe(403);
    expect(db.prepare("SELECT state FROM changes WHERE id = 'review-me'").get()).toEqual({ state: "review" });
    expect(forgejo.editPull).not.toHaveBeenCalled();
    expect(forgejo.deleteBranch).not.toHaveBeenCalled();
  });

  it("updates an existing PR title/body when publishing again", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const authorToken = seedUser(db, 1, "alice", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, title, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 'old title', 0, 0)",
    ).run();
    const forgejo = fakeForgejo();
    const app = appFor(db, forgejo);

    const publish = await app.request("/api/v1/w/w/publish", {
      method: "POST",
      headers: { authorization: `Bearer ${authorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ change_id: "repair-me", mode: "review", title: "new title", body: "new body" }),
    });

    expect(publish.status).toBe(200);
    expect(forgejo.editPull).toHaveBeenCalledWith("owner", "repo", 5, { title: "new title", body: "new body" }, "cs-alice");
    expect(db.prepare("SELECT state FROM changes WHERE id = 'repair-me'").get()).toEqual({ state: "review" });
  });

  it("keeps changes_requested out of the review queue but visible to the author", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const authorToken = seedUser(db, 1, "alice", "member");
    db.prepare(
      "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, title, created_at, updated_at) " +
        "VALUES ('repair-me', 1, 1, 'change/abc', 'changes_requested', 5, 'Repair me', 0, 0)",
    ).run();
    const app = appFor(db, fakeForgejo());

    const queue = await app.request("/api/v1/w/w/review-queue", {
      headers: { authorization: `Bearer ${authorToken}` },
    });
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toEqual({ queue: [] });

    const changesRes = await app.request("/api/v1/w/w/branches", {
      headers: { authorization: `Bearer ${authorToken}` },
    });
    expect(changesRes.status).toBe(200);
    const payload = await changesRes.json() as { changes: Array<{ id: string; state: string }> };
    expect(payload.changes.map((change) => [change.id, change.state])).toEqual([["repair-me", "changes_requested"]]);
  });
});
