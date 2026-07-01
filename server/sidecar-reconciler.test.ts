import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { Forgejo } from "./forgejo.js";
import { reconcileAllCoflatWorkspaces, summarizeReconcileResults } from "./sidecar-reconciler.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-reconcile-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

describe("sidecar reconciler", () => {
  it("reindexes all visible workspaces as Coflat", async () => {
    const db = freshDb();
    const files = {
      "owner/coflat": { "main.md": "---\nid: main\n---\n# Main v2\n" },
      "owner/pass": { "main.md": "---\nid: pass\n---\n# Pass\n" },
    };
    db.prepare(
      "INSERT INTO doc_map (workspace_slug, cosheaf_id, forgejo_id, title, created_at) VALUES ('owner/coflat', 'main', 'main.md', 'Main v1', 0)",
    ).run();
    const forgejo = {
      searchAllAccessibleRepos: vi.fn(async () => [
        {
          full_name: "owner/coflat",
          name: "coflat",
          owner: { login: "owner" },
          topics: ["cosheaf-format-coflat"],
        },
        {
          full_name: "owner/pass",
          name: "pass",
          owner: { login: "owner" },
          topics: [],
        },
      ]),
      getTree: vi.fn(async (owner: string, repo: string) =>
        Object.keys(files[`${owner}/${repo}` as keyof typeof files]).map((filePath) => ({
          path: filePath,
          type: "blob",
          sha: `sha-${filePath}`,
        })),
      ),
      getRawFile: vi.fn(async (owner: string, repo: string, _ref: string, filePath: string) =>
        files[`${owner}/${repo}` as keyof typeof files][filePath as "main.md"],
      ),
    } as unknown as Forgejo;

    const results = await reconcileAllCoflatWorkspaces(db, forgejo);

    expect(summarizeReconcileResults(results)).toEqual({ reindexed: 2, skipped: 0, failed: 0, pages: 2 });
    expect(db.prepare("SELECT title FROM doc_map WHERE workspace_slug = 'owner/coflat'").get()).toEqual({
      title: "Main v2",
    });
    expect(db.prepare("SELECT title FROM doc_map WHERE workspace_slug = 'owner/pass'").get()).toEqual({
      title: "Pass",
    });
  });
});
