import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../shared/document-format.js";
import { parseDocument } from "./frontmatter.js";
import { deleteCitationFile, deletePage, indexCitationFile, indexPage } from "./indexer.js";
import { freshTestDb } from "./routes/test-fixtures.js";

function freshDb(): Database.Database {
  // Indexer tests want a coflat workspace because the fixtures use [@id]
  // citation syntax; the default 'forgejo-passthrough' format wouldn't
  // extract those into backlinks. With the workspaces table gone (#62)
  // the format is just a parameter we pass to indexPage.
  return freshTestDb("cosheaf-idx-");
}

describe("indexPage", () => {
  it("generates a stable doc id and rewrites frontmatter on first write", () => {
    const db = freshDb();
    const r = indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "hello.md",
      bodyText: "# Hello\n\nbody.",
      formatId: COFLAT_FORMAT_ID,
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
      workspaceSlug: "owner/w",
      filePath: "page.md",
      bodyText: "# Page\n\nbody.",
      formatId: COFLAT_FORMAT_ID,
    });
    if (first.rewrittenContent === null) throw new Error("expected rewritten content");
    // Simulate a subsequent put_note carrying the rewritten content.
    const second = indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "page.md",
      bodyText: first.rewrittenContent,
      formatId: COFLAT_FORMAT_ID,
    });
    expect(second.cosheafId).toBe(first.cosheafId);
    // Already had id in frontmatter, so no rewrite needed.
    expect(second.rewrittenContent).toBeNull();
  });

  it("respects an explicit frontmatter id when provided", () => {
    const db = freshDb();
    const r = indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "explicit.md",
      bodyText: "---\nid: abcd1234\n---\n# Explicit\n",
      formatId: COFLAT_FORMAT_ID,
    });
    expect(r.cosheafId).toBe("abcd1234");
  });

  it("does not prepend generated frontmatter above a malformed delimited yaml block", () => {
    const db = freshDb();
    const source = [
      "---",
      "id: ztrcpji2",
      "bibliography: ref.bib",
      "title: \"Rank-k-reduction on matroid intersection\"",
      "math:",
      "\t\\cl: \"\\operatorname{cl}\"",
      "---",
      "",
      "motivated by Tamas Kiraly's question",
      "",
    ].join("\n");

    const r = indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "paper.md",
      bodyText: source,
      formatId: COFLAT_FORMAT_ID,
    });

    expect(r.rewrittenContent).toBeNull();
    expect(r.cosheafId).toMatch(/^[a-z0-9]{8}$/);
  });

  it("repairs a path row when frontmatter id changes on the same file", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "page.md",
      bodyText: "---\nid: one\n---\n# One\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "page.md",
      bodyText: "---\nid: two\n---\n# Two\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = 'owner/w'")
      .all() as Array<{ cosheaf_id: string; forgejo_id: string }>;
    expect(rows).toEqual([{ cosheaf_id: "two", forgejo_id: "page.md" }]);
  });

  it("generates a fresh id when another path already owns an explicit id", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "a.md",
      bodyText: "---\nid: same\n---\n# A\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const second = indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "b.md",
      bodyText: "---\nid: same\n---\n# B\n",
      formatId: COFLAT_FORMAT_ID,
    });

    expect(second.cosheafId).not.toBe("same");
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = 'owner/w' ORDER BY forgejo_id")
      .all() as Array<{ cosheaf_id: string; forgejo_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ cosheaf_id: "same", forgejo_id: "a.md" });
    expect(rows[1]?.forgejo_id).toBe("b.md");
    expect(rows[1]?.cosheaf_id).toBe(second.cosheafId);
  });

  it("keeps a collided page's id stable across reindexes (no churn)", () => {
    const db = freshDb();
    const ingest = (filePath: string) => ({
      workspaceSlug: "owner/w",
      filePath,
      bodyText: `---\nid: same\n---\n# ${filePath}\n`,
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, ingest("a.md"));
    const first = indexPage(db, ingest("b.md"));
    // Re-indexing b.md (still carrying the duplicate frontmatter id) must reuse
    // its already-assigned id, not mint a fresh random one on every run.
    const second = indexPage(db, ingest("b.md"));
    const third = indexPage(db, ingest("b.md"));
    expect(second.cosheafId).toBe(first.cosheafId);
    expect(third.cosheafId).toBe(first.cosheafId);
  });

  it("populates FTS, backlinks, and tags on insert", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "src.md",
      bodyText: "---\ntags:\n  - geometry\n  - lemma\n---\n# Source\n\n[@targetid] and [link](other.md#sec:part) and [[ignored]].\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const ftsRow = db
      .prepare("SELECT path, body FROM notes_fts WHERE workspace_slug = 'owner/w'")
      .get() as { path: string; body: string };
    expect(ftsRow.path).toBe("src.md");
    expect(ftsRow.body).toContain("Source");

    const links = db
      .prepare("SELECT target_label, line FROM backlinks WHERE workspace_slug = 'owner/w' ORDER BY target_label")
      .all() as Array<{ target_label: string; line: number }>;
    expect(links).toEqual([
      { target_label: "[@targetid]", line: 8 },
      { target_label: "[link](other.md#sec:part)", line: 8 },
    ]);

    const tags = db
      .prepare("SELECT tag FROM page_tags WHERE workspace_slug = 'owner/w' ORDER BY tag")
      .all() as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["geometry", "lemma"]);
  });

  it("forgejo-passthrough format extracts no backlinks for `[@id]` syntax (#25)", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "src.md",
      bodyText: "# Source\n\n[@targetid] and [link](other.md).\n",
      formatId: "forgejo-passthrough",
    });
    // doc_map row still created (page metadata) — but no backlinks.
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM backlinks WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    // FTS still indexed (search works regardless of format).
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
  });

  it("coflat format extracts both `[@id]` and `[link](path.md)` backlinks (#25)", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "src.md",
      bodyText: "# Source\n\n[@targetid] and [link](other.md).\n",
      formatId: "coflat",
    });
    const labels = (db
      .prepare("SELECT target_label FROM backlinks WHERE workspace_slug = 'owner/w' ORDER BY target_label")
      .all() as Array<{ target_label: string }>).map((r) => r.target_label);
    expect(labels).toEqual(["[@targetid]", "[link](other.md)"]);
  });

  it("resolves document-relative and root-relative markdown backlinks with Coflat path semantics", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "docs/target.md",
      bodyText: "---\nid: nested\n---\n# Nested\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "target.md",
      bodyText: "---\nid: root\n---\n# Root\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "docs/source.md",
      bodyText: "# Source\n\n[near](./target.md)\n[root](/target.md)\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const links = db
      .prepare("SELECT target_label, target_id FROM backlinks WHERE workspace_slug = 'owner/w' AND src_path = 'docs/source.md' ORDER BY target_label")
      .all() as Array<{ target_label: string; target_id: string }>;
    expect(links).toEqual([
      { target_label: "[near](./target.md)", target_id: "nested" },
      { target_label: "[root](/target.md)", target_id: "root" },
    ]);
  });

  it("indexes Coflat cross-reference targets for cross-file resolution", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "theory.md",
      bodyText: [
        "---",
        "id: theory",
        "---",
        "# Theory {#sec:theory}",
        "",
        "$$x = y$$ {#eq:identity}",
        "",
        '::: {#thm:identity .theorem title="Identity"}',
        "Every value equals itself.",
        ":::",
        "",
      ].join("\n"),
      formatId: COFLAT_FORMAT_ID,
    });

    const targets = db
      .prepare("SELECT target_id, source_path, kind, display_label FROM xref_targets WHERE workspace_slug = 'owner/w' ORDER BY target_id")
      .all() as Array<{ target_id: string; source_path: string; kind: string; display_label: string }>;
    expect(targets).toEqual([
      { target_id: "eq:identity", source_path: "theory.md", kind: "equation", display_label: "Eq. (1)" },
      { target_id: "sec:theory", source_path: "theory.md", kind: "heading", display_label: "Section 1" },
      { target_id: "thm:identity", source_path: "theory.md", kind: "block", display_label: "Theorem 1" },
    ]);

    deletePage(db, "owner/w", "theory.md");
    expect(db.prepare("SELECT count(*) AS c FROM xref_targets WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("indexes and deletes BibTeX citation keys", () => {
    const db = freshDb();
    const count = indexCitationFile(db, {
      workspaceSlug: "owner/w",
      filePath: "refs/main.bib",
      bodyText: [
        "@article{BoysenKW19,",
        "  title={A paper}",
        "}",
        "@book{RatliffR83,",
        "  title={A book}",
        "}",
      ].join("\n"),
    });

    expect(count).toBe(2);
    const keys = db
      .prepare("SELECT target_id, source_path FROM citation_targets WHERE workspace_slug = 'owner/w' ORDER BY target_id")
      .all() as Array<{ target_id: string; source_path: string }>;
    expect(keys).toEqual([
      { target_id: "BoysenKW19", source_path: "refs/main.bib" },
      { target_id: "RatliffR83", source_path: "refs/main.bib" },
    ]);

    deleteCitationFile(db, "owner/w", "refs/main.bib");
    expect(db.prepare("SELECT count(*) AS c FROM citation_targets WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("indexes xref target labels with Coflat frontmatter numbering", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "numbering.md",
      bodyText: [
        "---",
        "numbering: global",
        "---",
        "",
        "::: {.theorem #thm:first}",
        "First.",
        ":::",
        "",
        "::: {.table #tbl:apps}",
        "table",
        ":::",
        "",
        "::: {.theorem #thm:target}",
        "Target.",
        ":::",
      ].join("\n"),
      formatId: COFLAT_FORMAT_ID,
    });

    const targets = db
      .prepare("SELECT target_id, display_label FROM xref_targets WHERE workspace_slug = 'owner/w' ORDER BY target_id")
      .all() as Array<{ target_id: string; display_label: string }>;
    expect(targets).toEqual([
      { target_id: "tbl:apps", display_label: "Table 2" },
      { target_id: "thm:first", display_label: "Theorem 1" },
      { target_id: "thm:target", display_label: "Theorem 3" },
    ]);
  });

  it("indexes with trigram tokenizer for CJK search", () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "cjk.md",
      bodyText: "# 紧性\n\n这是一个紧性定理。\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const row = db
      .prepare("SELECT path FROM notes_fts WHERE workspace_slug = 'owner/w' AND notes_fts MATCH ?")
      .get("\"紧性定理\"") as { path: string } | undefined;
    expect(row?.path).toBe("cjk.md");
  });

  it("deletePage removes doc_map row and sidecar entries", () => {
    const db = freshDb();
    indexPage(db, { workspaceSlug: "owner/w", filePath: "gone.md", bodyText: "# Gone", formatId: COFLAT_FORMAT_ID });
    expect(db.prepare("SELECT count(*) AS c FROM doc_map").get()).toEqual({ c: 1 });
    deletePage(db, "owner/w", "gone.md");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts").get()).toEqual({ c: 0 });
  });
});
