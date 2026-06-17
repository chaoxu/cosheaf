import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { freshTestDb } from "./routes/test-fixtures.js";
import { searchWorkspacePages } from "./page-search.js";

function seedPage(db: Database.Database, slug: string, id: string, path: string, title: string, body: string): void {
  db.prepare(
    "INSERT INTO notes_fts (workspace_slug, cosheaf_id, path, title, body) VALUES (?, ?, ?, ?, ?)",
  ).run(slug, id, path, title, body);
}

let db: Database.Database;
afterEach(() => db?.close());

describe("searchWorkspacePages", () => {
  function fresh(): Database.Database {
    db = freshTestDb("cosheaf-search-");
    seedPage(db, "owner/w", "alpha", "alpha.md", "Alpha page", "The conservation theorem holds for flushing coins.");
    seedPage(db, "owner/w", "beta", "notes/beta.md", "Beta notes", "Unrelated content about widgets.");
    seedPage(db, "other/x", "gamma", "gamma.md", "Gamma", "conservation theorem in another workspace.");
    return db;
  }

  it("returns FTS matches scoped to the workspace, with a highlighted snippet", () => {
    fresh();
    const results = searchWorkspacePages(db, "owner/w", "conservation");
    expect(results.map((r) => r.doc_id)).toEqual(["alpha"]);
    // the cross-workspace row never leaks
    expect(results.some((r) => r.doc_id === "gamma")).toBe(false);
    const matched = results[0].snippet.find((p) => p.match);
    expect(matched?.text.toLowerCase()).toContain("conservation");
  });

  it("falls back to a substring LIKE match when FTS finds nothing", () => {
    fresh();
    // 'widget' is a substring of 'widgets'; trigram FTS on the bare term may
    // miss it, but the LIKE fallback still surfaces beta.
    const results = searchWorkspacePages(db, "owner/w", "widget");
    expect(results.map((r) => r.doc_id)).toEqual(["beta"]);
  });

  it("returns nothing for a query with no usable terms", () => {
    fresh();
    expect(searchWorkspacePages(db, "owner/w", "   ")).toEqual([]);
    expect(searchWorkspacePages(db, "owner/w", "@#$")).toEqual([]);
  });

  it("returns nothing when no page matches", () => {
    fresh();
    expect(searchWorkspacePages(db, "owner/w", "nonexistentxyz")).toEqual([]);
  });

  it("honors the result limit", () => {
    db = freshTestDb("cosheaf-search-");
    for (let i = 0; i < 10; i++) seedPage(db, "owner/w", `p${i}`, `p${i}.md`, `Page ${i}`, "shared keyword body");
    expect(searchWorkspacePages(db, "owner/w", "keyword", 3)).toHaveLength(3);
  });

  it("defaults non-integer limits before querying SQLite", () => {
    db = freshTestDb("cosheaf-search-");
    for (let i = 0; i < 30; i++) seedPage(db, "owner/w", `p${i}`, `p${i}.md`, `Page ${i}`, "shared keyword body");
    expect(searchWorkspacePages(db, "owner/w", "keyword", 1.5)).toHaveLength(25);
  });
});
