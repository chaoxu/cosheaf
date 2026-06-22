// Regression guard for #36: SQLite is a derived sidecar, not a mirror of
// Forgejo workflow state. Each row in this allowlist is justified in
// AGENTS.md's "Core principles" section. New tables outside the list need a
// design decision recorded there (and probably a thumbs-down).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ALLOWED_TABLES = new Set([
  // Derived document index from Forgejo content (rebuildable via reindex)
  "doc_map",
  "backlinks",
  "xref_targets",
  "citation_targets",
  "xref_target_duplicates",
  "page_tags",
  // Parsed cosheaf.yaml cached per branch (#182). Derived/rebuildable from the
  // authoritative file on Forgejo; busted by webhook, cleared by reindex.
  "repo_config",
  "notes_fts",
  // FTS5 virtual table emits configuration rows in sqlite_master:
  "notes_fts_data",
  "notes_fts_idx",
  "notes_fts_content",
  "notes_fts_docsize",
  "notes_fts_config",
  // Webhook idempotency
  "webhook_log",
  // Cosheaf-issued Forgejo PAT cache; login validates credentials before reuse
  "login_tokens",
  // Cosheaf-owned site controls: global admin bootstrap and registration gate.
  "site_admins",
  "site_settings",
  "registration_invites",
  // Ephemeral process coordination for sidecar rebuilds. Rows are disposable
  // locks, not knowledge or Forgejo workflow mirrors.
  "workspace_locks",
  // Optional live-work leases (#95): ephemeral coordination state, no Forgejo
  // source. Disposable like webhook_log — rows expire; NOT durable knowledge,
  // and issues/PRs stay the only durable state on Forgejo.
  "issue_claims",
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
