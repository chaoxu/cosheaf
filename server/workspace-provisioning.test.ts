import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT_FORMAT_ID } from "../shared/document-format.js";
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
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoAdminToken: "admin-token",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  publicOrigin: null,
  registrationOpen: false,
  trustedProxyHops: 0,
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
  reconcileIntervalMs: 0,
};

function fakeForgejo(files: Record<string, string> = {}): Forgejo {
  const repos = new Set<string>();
  return {
    getRepo: vi.fn(async (owner: string, repo: string) =>
      repos.has(repo) ? { name: repo, full_name: `${owner}/${repo}` } : null,
    ),
    // The "admin" path resolves the committing identity (the site admin) to
    // put it on the branch-protection push whitelist.
    getCurrentUser: vi.fn(async () => ({ login: "cosheaf-admin" })),
    // The tests provision via the site-admin path (provisionVia: "admin"),
    // matching the CLI/seed callers.
    createRepoForUser: vi.fn(async (owner: string, opts: { name: string }) => {
      repos.add(opts.name);
      return { name: opts.name, full_name: `${owner}/${opts.name}` };
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
    listRepoTopics: vi.fn(async () => [] as string[]),
    replaceRepoTopics: vi.fn(async () => undefined),
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
    const user = { username: "chao" };

    const result = await provisionWorkspace(db, forgejo, config, {
      owner: "owner",
      repo: "notes",
      name: "Notes",
      user,
      forgejoUsername: "chao",
      provisionVia: "admin",
      rollbackCreatedRepoOnLocalFailure: true,
      defaultMdFormat: "coflat",
    });

    expect(result.createdRepo).toBe(true);
    expect(result.workspace.owner).toBe("owner");
    expect(result.workspace.repo).toBe("notes");
    expect(result.workspace.slug).toBe("owner/notes");
    expect(result.workspace.defaultMdFormat).toBe("coflat");
    expect(forgejo.addCollaborator).toHaveBeenCalledWith("owner", "notes", "chao", "admin");
    expect(forgejo.addCollaborator).not.toHaveBeenCalledWith("owner", "notes", "coverify", "write");
    expect(db.prepare("SELECT path FROM notes_fts WHERE workspace_slug = ?").get(result.workspace.slug))
      .toEqual({ path: "readme.md" });
    expect(forgejo.createBranchProtection).toHaveBeenCalledOnce();
    expect(forgejo.createRepoHook).toHaveBeenCalledOnce();
    expect(forgejo.createRepoHook).toHaveBeenCalledWith(
      "owner",
      "notes",
      config.webhookUrl,
      config.webhookSecret,
      expect.arrayContaining(["push", "repository"]),
    );
    expect(forgejo.putFile).toHaveBeenCalledWith(
      "owner",
      "notes",
      expect.objectContaining({ path: ".gitattributes" }),
    );
  });

  it("adds the Coverify bot only when chat replies are configured", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo();
    const user = { username: "chao" };

    await provisionWorkspace(db, forgejo, { ...config, coverifyBotToken: "bot-token" }, {
      owner: "owner",
      repo: "notes",
      name: "Notes",
      user,
      forgejoUsername: "chao",
      provisionVia: "admin",
    });

    expect(forgejo.addCollaborator).toHaveBeenCalledWith("owner", "notes", "coverify", "write");
  });

  it("skips webhook registration for passthrough workspaces (#64)", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo();
    const user = { username: "chao" };

    await provisionWorkspace(db, forgejo, config, {
      owner: "owner",
      repo: "notes",
      name: "Notes",
      user,
      forgejoUsername: "chao",
      provisionVia: "admin",
      defaultMdFormat: DEFAULT_DOCUMENT_FORMAT_ID, // forgejo-passthrough
    });

    expect(forgejo.createRepoHook).not.toHaveBeenCalled();
  });

  it("allows seed-style idempotent provisioning of an existing workspace", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo();
    const user = { username: "chao" };

    await provisionWorkspace(db, forgejo, config, {
      owner: "owner",
      repo: "notes",
      name: "Notes",
      user,
      forgejoUsername: "chao",
      provisionVia: "admin",
      allowExistingLocal: true,
    });
    await provisionWorkspace(db, forgejo, config, {
      owner: "owner",
      repo: "notes",
      name: "Notes renamed",
      user,
      forgejoUsername: "chao",
      provisionVia: "admin",
      allowExistingLocal: true,
    });

    // Idempotent re-provisioning: a second call should not fail. The
    // workspaces table is gone (#62), so there's no row-count to assert;
    // the assertion is implicit in `provisionWorkspace` not throwing.
  });

  it("reindex removes pages no longer present in Forgejo main", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo({ "keep.md": "# Keep\n" });
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES ('gone', 'owner/w', 'gone.md', 'Gone', 0)",
    ).run();
    db.prepare(
      "INSERT INTO notes_fts (workspace_slug, cosheaf_id, path, title, body) VALUES ('owner/w', 'gone', 'gone.md', 'Gone', 'Gone')",
    ).run();

    const count = await reindexWorkspaceFromForgejo(db, forgejo, { owner: "owner", repo: "w", slug: "owner/w", defaultMdFormat: "coflat" });

    expect(count).toBe(1);
    expect(db.prepare("SELECT forgejo_id FROM doc_map WHERE workspace_slug = 'owner/w' ORDER BY forgejo_id").all())
      .toEqual([{ forgejo_id: "keep.md" }]);
  });

  it("reindex resolves cross-file links independent of Forgejo tree order", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo({
      "a.md": "---\nid: a\n---\n# A\n\n[B](b.md)\n",
      "b.md": "---\nid: b\n---\n# B\n",
    });

    const count = await reindexWorkspaceFromForgejo(db, forgejo, { owner: "owner", repo: "w", slug: "owner/w", defaultMdFormat: "coflat" });

    expect(count).toBe(2);
    expect(
      db.prepare("SELECT target_id FROM backlinks WHERE workspace_slug = 'owner/w' AND src_path = 'a.md'").get(),
    ).toEqual({ target_id: "b" });
  });

  it("reindex rebuilds BibTeX citation keys and removes stale citation files", async () => {
    const db = freshDb();
    const forgejo = fakeForgejo({
      "keep.md": "# Keep\n\nSee [@BoysenKW19].\n",
      "refs/main.bib": "@article{BoysenKW19, title={Valid citation}}\n",
    });
    db.prepare(
      "INSERT INTO citation_targets (workspace_slug, target_id, source_path) VALUES ('owner/w', 'gone', 'refs/gone.bib')",
    ).run();

    const count = await reindexWorkspaceFromForgejo(db, forgejo, { owner: "owner", repo: "w", slug: "owner/w", defaultMdFormat: "coflat" });

    expect(count).toBe(1);
    expect(db.prepare("SELECT target_id, source_path FROM citation_targets WHERE workspace_slug = 'owner/w'").all())
      .toEqual([{ target_id: "BoysenKW19", source_path: "refs/main.bib" }]);
  });
});
