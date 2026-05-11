import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { deletePage, indexPage } from "./indexer.js";
import { parseDocument } from "./frontmatter.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-idx-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  // Minimal seed: one workspace.
  db.prepare("INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'w', 0)").run();
  return db;
}

describe("indexPage", () => {
  it("generates a stable doc id and rewrites frontmatter on first write", () => {
    const db = freshDb();
    const r = indexPage(db, {
      workspaceId: 1,
      filePath: "hello.md",
      bodyText: "# Hello\n\nbody.",
    });
    expect(r.cosheafId).toMatch(/^[a-z0-9]{8}$/);
    expect(r.title).toBe("Hello");
    expect(r.rewrittenContent).not.toBeNull();
    if (r.rewrittenContent === null) throw new Error("expected rewritten content");
    const parsed = parseDocument(r.rewrittenContent);
    expect(parsed.frontmatter.id).toBe(r.cosheafId);
  });

  it("preserves an existing frontmatter id across re-indexing", () => {
    const db = freshDb();
    const first = indexPage(db, {
      workspaceId: 1,
      filePath: "page.md",
      bodyText: "# Page\n\nbody.",
    });
    if (first.rewrittenContent === null) throw new Error("expected rewritten content");
    // Simulate a subsequent put_note carrying the rewritten content.
    const second = indexPage(db, {
      workspaceId: 1,
      filePath: "page.md",
      bodyText: first.rewrittenContent,
    });
    expect(second.cosheafId).toBe(first.cosheafId);
    // Already had id in frontmatter, so no rewrite needed.
    expect(second.rewrittenContent).toBeNull();
  });

  it("respects an explicit frontmatter id when provided", () => {
    const db = freshDb();
    const r = indexPage(db, {
      workspaceId: 1,
      filePath: "explicit.md",
      bodyText: "---\nid: abcd1234\n---\n# Explicit\n",
    });
    expect(r.cosheafId).toBe("abcd1234");
  });

  it("repairs a path row when frontmatter id changes on the same file", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceId: 1,
      filePath: "page.md",
      bodyText: "---\nid: one\n---\n# One\n",
    });
    indexPage(db, {
      workspaceId: 1,
      filePath: "page.md",
      bodyText: "---\nid: two\n---\n# Two\n",
    });

    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_id = 1")
      .all() as Array<{ cosheaf_id: string; forgejo_id: string }>;
    expect(rows).toEqual([{ cosheaf_id: "two", forgejo_id: "page.md" }]);
  });

  it("generates a fresh id when another path already owns an explicit id", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceId: 1,
      filePath: "a.md",
      bodyText: "---\nid: same\n---\n# A\n",
    });
    const second = indexPage(db, {
      workspaceId: 1,
      filePath: "b.md",
      bodyText: "---\nid: same\n---\n# B\n",
    });

    expect(second.cosheafId).not.toBe("same");
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_id = 1 ORDER BY forgejo_id")
      .all() as Array<{ cosheaf_id: string; forgejo_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ cosheaf_id: "same", forgejo_id: "a.md" });
    expect(rows[1]?.forgejo_id).toBe("b.md");
    expect(rows[1]?.cosheaf_id).toBe(second.cosheafId);
  });

  it("populates FTS, backlinks, and tags on insert", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceId: 1,
      filePath: "src.md",
      bodyText: "---\ntags:\n  - geometry\n  - lemma\n---\n# Source\n\n[@targetid] and [link](other.md#sec:part) and [[ignored]].\n",
    });
    const ftsRow = db
      .prepare("SELECT path, body FROM notes_fts WHERE workspace_id = 1")
      .get() as { path: string; body: string };
    expect(ftsRow.path).toBe("src.md");
    expect(ftsRow.body).toContain("Source");

    const links = db
      .prepare("SELECT target_label FROM backlinks WHERE workspace_id = 1 ORDER BY target_label")
      .all() as Array<{ target_label: string }>;
    expect(links.map((l) => l.target_label)).toEqual([
      "[@targetid]",
      "[link](other.md#sec:part)",
    ]);

    const tags = db
      .prepare("SELECT tag FROM page_tags WHERE workspace_id = 1 ORDER BY tag")
      .all() as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["geometry", "lemma"]);
  });

  it("indexes with trigram tokenizer for CJK search", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceId: 1,
      filePath: "cjk.md",
      bodyText: "# 紧性\n\n这是一个紧性定理。\n",
    });
    const row = db
      .prepare("SELECT path FROM notes_fts WHERE workspace_id = 1 AND notes_fts MATCH ?")
      .get("\"紧性定理\"") as { path: string } | undefined;
    expect(row?.path).toBe("cjk.md");
  });

  it("deletePage removes doc_map row and sidecar entries", () => {
    const db = freshDb();
    indexPage(db, { workspaceId: 1, filePath: "gone.md", bodyText: "# Gone" });
    expect(db.prepare("SELECT count(*) AS c FROM doc_map").get()).toEqual({ c: 1 });
    deletePage(db, 1, "gone.md");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts").get()).toEqual({ c: 0 });
  });
});
