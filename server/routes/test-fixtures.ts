// Shared boilerplate for route-level tests. The auth/membership helpers
// live alongside in server/test-helpers.ts; this module covers the db
// lifecycle + the small Response builders. Per-route tests still own
// their own `appFor()` (routers differ) and any Forgejo-payload fixtures
// that are route-specific.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach } from "vitest";

// Tracks every Database returned by freshTestDb() so a single afterEach
// closes them and cleans up the tmpdir behind them. Without this each
// test file leaked one tmpdir per freshDb() call.
const openDbs: Array<{ db: Database.Database; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of openDbs.splice(0)) {
    try { db.close(); } catch (_err) { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* already gone */ }
  }
});

const SCHEMA = readFileSync(path.join(import.meta.dirname, "..", "schema.sql"), "utf8");

// Build a fresh, isolated SQLite under a tmpdir. WAL + FK on. The caller
// seeds rows it needs; seedTestWorkspace() is the common one and lives
// alongside.
export function freshTestDb(prefix = "cosheaf-test-"): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = new Database(path.join(dir, "test.sqlite"));
  openDbs.push({ db, dir });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

interface WorkspaceSeed {
  id?: number;
  slug?: string;
  default_md_format?: string;
}

// Insert a workspaces row with sensible defaults. Idempotent on (id) so
// repeat callers in the same test don't blow up.
export function seedTestWorkspace(db: Database.Database, init: WorkspaceSeed = {}): void {
  const id = init.id ?? 1;
  const slug = init.slug ?? "w";
  if (init.default_md_format !== undefined) {
    db.prepare(
      "INSERT OR IGNORE INTO workspaces (id, slug, default_md_format, created_at) VALUES (?, ?, ?, 0)",
    ).run(id, slug, init.default_md_format);
    return;
  }
  db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, slug, created_at) VALUES (?, ?, 0)",
  ).run(id, slug);
}

// JSON Response builder for fetchMock. Default status is 200; the
// existing webhook/auth tests pass an explicit 201 etc. when they need
// it. Headers may carry e.g. content-type overrides for raw-file mocks.
export function responseOk(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// Empty-body Response. 204/205 are no-body statuses that the Response
// constructor rejects with a non-null body; we substitute 200 there
// rather than fail at construction.
export function responseEmpty(status = 200): Response {
  const safe = status === 204 || status === 205 ? 200 : status;
  return new Response(null, { status: safe });
}
