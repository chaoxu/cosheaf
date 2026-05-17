// Regression guard for #36: SQLite is a derived sidecar, not a mirror of
// Forgejo workflow state. Each row in this allowlist is justified in
// AGENTS.md's "Core principles" section. New tables outside the list need a
// design decision recorded there (and probably a thumbs-down).

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_TABLES = new Set([
  // Local auth
  "users",
  "sessions",
  // Workspace → Forgejo repo mapping
  "workspaces",
  // Derived document index from Forgejo content (rebuildable via reindex)
  "doc_map",
  "backlinks",
  "page_tags",
  "notes_fts",
  // FTS5 virtual table emits a configuration row in sqlite_master:
  "notes_fts_data",
  "notes_fts_idx",
  "notes_fts_content",
  "notes_fts_docsize",
  "notes_fts_config",
  // Webhook idempotency + passthrough audit
  "webhook_log",
  "forgejo_passthrough_log",
  // SQLite internal
  "sqlite_sequence",
]);

describe("sqlite schema allowlist (#36 — no Forgejo state mirror)", () => {
  it("schema.sql contains only allowed tables", () => {
    const schemaPath = join(import.meta.dirname, "schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    const db = new Database(":memory:");
    db.exec(schema);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const unexpected = rows.map((r) => r.name).filter((n) => !ALLOWED_TABLES.has(n));
    expect(unexpected, "new tables outside the allowlist need a design decision").toEqual([]);
    db.close();
  });
});
