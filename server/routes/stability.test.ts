import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
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

function seedUser(db: Database.Database, id: number, username: string, role: "owner" | "verifier" | "member"): string {
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

  it("abandons an empty draft publish instead of leaving a stale draft", async () => {
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
    expect(db.prepare("SELECT state FROM changes WHERE id = 'empty'").get()).toEqual({ state: "abandoned" });
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

    const res = await app.request("/api/v1/w/w/change/self/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ comment: "looks good to me" }),
    });

    expect(res.status).toBe(403);
    expect(forgejo.createReview).not.toHaveBeenCalled();
  });
});
