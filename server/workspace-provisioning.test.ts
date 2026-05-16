import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import {
  provisionWorkspace,
  reindexWorkspaceFromForgejo,
} from "./workspace-provisioning.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-workspace-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

const config: Config = {
  dataDir: "/tmp/cosheaf-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function fakeForgejo(files: Record<string, string> = {}): Forgejo {
  const repos = new Set<string>();
  return {
    getRepo: vi.fn(async (_owner: string, repo: string) =>
      repos.has(repo) ? { name: repo, full_name: `owner/${repo}` } : null,
    ),
    createUserRepo: vi.fn(async (opts: { name: string }) => {
      repos.add(opts.name);
      return { name: opts.name, full_name: `owner/${opts.name}` };
    }),
    deleteRepo: vi.fn(async (_owner: string, repo: string) => {
      repos.delete(repo);
    }),
    addCollaborator: vi.fn(async () => undefined),
    getBranchProtection: vi.fn(async () => null),
    createBranchProtection: vi.fn(async () => ({ branch_name: "main", required_approvals: 1 })),
    patchBranchProtectionPushWhitelist: vi.fn(async () => ({ branch_name: "main", required_approvals: 1 })),
    listRepoHooks: vi.fn(async () => []),
    createRepoHook: vi.fn(async () => ({ id: 1, type: "forgejo", events: ["push"] })),
    getFileMeta: vi.fn(async (_owner: string, _repo: string, _ref: string, filePath: string) =>
      files[filePath] === undefined ? null : { path: filePath, sha: `sha-${filePath}`, type: "file" },
    ),
    putFile: vi.fn(async (_owner: string, _repo: string, opts: { path: string; content: string }) => {
      files[opts.path] = opts.content;
      return { content: null, commit: { sha: "commit" } };
    }),
    getTree: vi.fn(async () =>
      Object.keys(files).map((filePath) => ({ path: filePath, type: "blob", sha: `sha-${filePath}` })),
    ),
    getRawFile: vi.fn(async (_owner: string, _repo: string, _ref: string, filePath: string) => files[filePath] ?? ""),
    listIssues: vi.fn(async () => []),
  } as unknown as Forgejo;
}

describe("workspace provisioning", () => {
  it("provisions a workspace, owner membership, repo policy, hook, and initial index", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo({ "readme.md": "# Readme\n\nhello" });
    const user = { id: 7, username: "chao", forgejo_username: "cs-chao" };
    db.prepare("INSERT INTO users (id, username, password_hash, forgejo_username, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.username, "hash", user.forgejo_username, 0);

    const result = await provisionWorkspace(db, forgejo, config, {
      slug: "notes",
      name: "Notes",
      user,
      forgejoUsername: "cs-chao",
      rollbackCreatedRepoOnLocalFailure: true,
    });

    expect(result.createdRepo).toBe(true);
    expect(result.workspace.slug).toBe("notes");
    expect(forgejo.addCollaborator).toHaveBeenCalledWith("owner", "notes", "cs-chao", "admin");
    expect(db.prepare("SELECT path FROM notes_fts WHERE workspace_id = ?").get(result.workspace.id))
      .toEqual({ path: "readme.md" });
    expect(forgejo.createBranchProtection).toHaveBeenCalledOnce();
    expect(forgejo.createRepoHook).toHaveBeenCalledOnce();
    expect(forgejo.putFile).toHaveBeenCalledWith(
      "owner",
      "notes",
      expect.objectContaining({ path: ".gitattributes" }),
    );
  });

  it("allows seed-style idempotent provisioning of an existing workspace", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo();
    const user = { id: 1, username: "chao", forgejo_username: "cs-chao" };
    db.prepare("INSERT INTO users (id, username, password_hash, forgejo_username, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.username, "hash", user.forgejo_username, 0);

    await provisionWorkspace(db, forgejo, config, {
      slug: "notes",
      name: "Notes",
      user,
      forgejoUsername: "cs-chao",
      allowExistingLocal: true,
    });
    await provisionWorkspace(db, forgejo, config, {
      slug: "notes",
      name: "Notes renamed",
      user,
      forgejoUsername: "cs-chao",
      allowExistingLocal: true,
    });

    expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT name FROM workspaces WHERE slug = 'notes'").get()).toEqual({ name: "Notes renamed" });
  });

  it("reindex removes pages no longer present in Forgejo main", async () => {
    const db = freshDb();
    db.prepare("INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'w', 0)").run();
    const forgejo = fakeForgejo({ "keep.md": "# Keep\n" });
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_id, doc_type, forgejo_kind, forgejo_id, title, created_at) " +
        "VALUES ('gone', 1, 'page', 'file', 'gone.md', 'Gone', 0)",
    ).run();
    db.prepare(
      "INSERT INTO notes_fts (workspace_id, cosheaf_id, doc_type, path, title, body) VALUES (1, 'gone', 'page', 'gone.md', 'Gone', 'Gone')",
    ).run();

    const count = await reindexWorkspaceFromForgejo(db, forgejo, config, { id: 1, forgejo_repo: "w" });

    expect(count).toBe(1);
    expect(db.prepare("SELECT forgejo_id FROM doc_map WHERE workspace_id = 1 ORDER BY forgejo_id").all())
      .toEqual([{ forgejo_id: "keep.md" }]);
  });
});
