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
import { changes } from "./changes.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-pr-view-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-pr-view-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  return db;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function seed(db: Database.Database): { token: string } {
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
  ).run();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, forgejo_username, created_at) VALUES (1, 'alice', 'hash', 'cs-alice', 0)",
  ).run();
  const token = "cs_alice";
  db.prepare(
    "INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (1, 'test', ?, 0)",
  ).run(sha256Hex(token));
  db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (1, 1, 'verifier')").run();
  return { token };
}

function seedChange(db: Database.Database, id: string, prNumber: number | null, state: string): void {
  db.prepare(
    "INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, pr_number, created_at, updated_at) " +
      "VALUES (?, 1, 1, ?, ?, ?, 0, 0)",
  ).run(id, `change/${id}`, state, prNumber);
}

function fakeForgejo(overrides: Partial<Forgejo> = {}): Forgejo {
  return {
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
      if (ref === "base-sha" && filePath === "hello.md") return "context\nold\n";
      if (ref === "head-sha" && filePath === "hello.md") return "context\nnew\nadded\n";
      if (ref === "head-sha" && filePath === "new.md") return "a\nb\nc\n";
      throw new ForgejoError(404, "not found", "GET", `/${filePath}`);
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

describe("PR view endpoints", () => {
  it("GET /change/:id/pr returns PR metadata", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "abc", 7, "review");
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/change/abc/pr", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pr?: Record<string, unknown>; files?: Array<Record<string, unknown>> };
    expect(body.pr).toMatchObject({
      number: 7,
      title: "Add a thing",
      state: "review",
      author_user_id: 1,
      author_username: "cs-author",
      head_sha: "head-sha",
      base_sha: "base-sha",
      additions_total: 5,
      deletions_total: 2,
      files_changed: 1,
    });
  });

  it("GET /change/:id/pr returns 409 when the change has no PR yet", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "draft", null, "draft");
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/change/draft/pr", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
  });

  it("GET /change/:id/diff returns per-file metadata with split patches", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "abc", 7, "review");
    const app = appFor(db, fakeForgejo());

    const res = await app.request("/api/v1/w/w/change/abc/diff", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pr?: Record<string, unknown>; files?: Array<Record<string, unknown>> };
    expect(body.files).toHaveLength(2);
    const [hello, added] = body.files ?? [];
    expect(hello.path).toBe("hello.md");
    expect(hello.status).toBe("modified");
    expect(hello.patch).toContain("+new");
    expect(hello.patch).not.toContain("diff --git a/new.md");
    expect(added.path).toBe("new.md");
    expect(added.status).toBe("added");
    expect(added.patch).toContain("@@ -0,0 +1,3 @@");
  });

  it("GET /change/:id/file returns content at the requested side", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "abc", 7, "review");
    const app = appFor(db, fakeForgejo());

    const headRes = await app.request(
      "/api/v1/w/w/change/abc/file?path=hello.md&side=head",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(headRes.status).toBe(200);
    expect(await headRes.json()).toEqual({ content: "context\nnew\nadded\n" });

    const baseRes = await app.request(
      "/api/v1/w/w/change/abc/file?path=hello.md&side=base",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(baseRes.status).toBe(200);
    expect(await baseRes.json()).toEqual({ content: "context\nold\n" });
  });

  it("GET /change/:id/file 404s when the file is absent on the requested side", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "abc", 7, "review");
    const app = appFor(db, fakeForgejo());

    const res = await app.request(
      "/api/v1/w/w/change/abc/file?path=new.md&side=base",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it("GET /change/:id/file rejects invalid side", async () => {
    const db = freshDb();
    const { token } = seed(db);
    seedChange(db, "abc", 7, "review");
    const app = appFor(db, fakeForgejo());

    const res = await app.request(
      "/api/v1/w/w/change/abc/file?path=hello.md&side=bogus",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
  });
});
