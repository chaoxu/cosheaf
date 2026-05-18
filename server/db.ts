import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load .env.dev from the repo root or CWD if present, so CLI / dev
// invocations don't need `set -a; source ./.env.dev; set +a`. Uses Node's
// built-in process.loadEnvFile() (Node 21.7+). Existing process.env wins.
for (const candidate of [
  path.resolve(__dirname, "..", ".env.dev"),
  path.resolve(process.cwd(), ".env.dev"),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export interface Config {
  dataDir: string;
  port: number;
  forgejoUrl: string;
  forgejoToken: string;
  forgejoOwner: string;
  webhookSecret: string;
  webhookUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `missing required env var: ${name}\n` +
        "  Did you copy .env.example to .env.dev and load it?\n" +
        "  cosheaf reads .env.dev (or whatever NODE_ENV points to) via process.loadEnvFile.",
    );
    process.exit(1);
  }
  return v;
}

function withDefault(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const dataDir = process.env.COSHEAF_DATA_DIR ?? path.resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    port: Number(process.env.COSHEAF_PORT ?? 3030),
    forgejoUrl: withDefault("COSHEAF_FORGEJO_URL", "http://127.0.0.1:3002"),
    forgejoToken: required("COSHEAF_FORGEJO_TOKEN"),
    forgejoOwner: withDefault("COSHEAF_FORGEJO_OWNER", "cosheaf-admin"),
    webhookSecret: required("COSHEAF_WEBHOOK_SECRET"),
    webhookUrl: withDefault("COSHEAF_WEBHOOK_URL", "http://127.0.0.1:3030/api/v1/webhooks/forgejo"),
  };
}

let dbInstance: Database.Database | null = null;

// Drop legacy doc_type/forgejo_kind columns and the doc_type FTS column on
// existing DBs. The sidecar is rebuildable; we don't preserve FTS content —
// `pnpm cli workspace reindex <slug>` regenerates it from Forgejo. The
// migration is idempotent: it only runs if the columns are still present.
// Drop the legacy `issues` / `issue_assignees` tables on existing DBs.
// The mirror is gone; routes now proxy to Forgejo directly.
function migrateDropIssuesSidecar(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_issues_state;
    DROP INDEX IF EXISTS idx_issues_author;
    DROP INDEX IF EXISTS idx_issue_assignees_user;
    DROP TABLE IF EXISTS issue_assignees;
    DROP TABLE IF EXISTS issues;
  `);
}

function migrateBacklinksLine(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('backlinks')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "line")) {
    db.exec("ALTER TABLE backlinks ADD COLUMN line INTEGER;");
  }
}

function migrateDropDocKindColumns(db: Database.Database): void {
  const docMapCols = db.prepare("PRAGMA table_info('doc_map')").all() as Array<{ name: string }>;
  const has = (name: string): boolean => docMapCols.some((c) => c.name === name);
  if (has("doc_type") || has("forgejo_kind")) {
    // Can't ALTER DROP COLUMN: the legacy `UNIQUE (workspace_id, forgejo_kind,
    // forgejo_id)` constraint references the column we're dropping. Recreate
    // the table with the current shape and copy what's there.
    db.exec(`
      CREATE TABLE doc_map_new (
        cosheaf_id TEXT NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        forgejo_id TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, cosheaf_id),
        UNIQUE (workspace_id, forgejo_id)
      );
      INSERT INTO doc_map_new (cosheaf_id, workspace_id, forgejo_id, title, created_at)
        SELECT cosheaf_id, workspace_id, forgejo_id, title, created_at FROM doc_map;
      DROP TABLE doc_map;
      ALTER TABLE doc_map_new RENAME TO doc_map;
    `);
  }
  const ftsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'")
    .get() as { sql: string } | undefined;
  const ftsNeedsRebuild =
    !ftsRow ||
    !/tokenize\s*=\s*'?trigram'?/i.test(ftsRow.sql) ||
    /\bdoc_type\b/i.test(ftsRow.sql);
  if (ftsRow && ftsNeedsRebuild) {
    db.exec(`
      DROP TABLE notes_fts;
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        workspace_id UNINDEXED,
        cosheaf_id UNINDEXED,
        path,
        title,
        body,
        tokenize='trigram'
      );
    `);
  }
}

// Legacy sidecar tables keyed off `workspace_id INTEGER` (FK into the old
// `workspaces` table) get rewritten to key off `workspace_slug TEXT`. We
// detect the legacy shape and migrate in place, preserving rows by joining
// through the workspaces table while it still exists, then drop it.
function migrateDropWorkspacesTable(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const has = (name: string): boolean => tables.some((t) => t.name === name);
  if (!has("workspaces")) return; // already migrated

  const colHas = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === col);

  db.exec("BEGIN");
  try {
    if (has("doc_map") && colHas("doc_map", "workspace_id")) {
      db.exec(`
        CREATE TABLE doc_map_new (
          cosheaf_id TEXT NOT NULL,
          workspace_slug TEXT NOT NULL,
          forgejo_id TEXT NOT NULL,
          title TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_slug, cosheaf_id),
          UNIQUE (workspace_slug, forgejo_id)
        );
        INSERT INTO doc_map_new (cosheaf_id, workspace_slug, forgejo_id, title, created_at)
          SELECT d.cosheaf_id, w.slug, d.forgejo_id, d.title, d.created_at
          FROM doc_map d JOIN workspaces w ON w.id = d.workspace_id;
        DROP TABLE doc_map;
        ALTER TABLE doc_map_new RENAME TO doc_map;
      `);
    }
    if (has("backlinks") && colHas("backlinks", "workspace_id")) {
      db.exec(`
        CREATE TABLE backlinks_new (
          workspace_slug TEXT NOT NULL,
          src_id TEXT NOT NULL,
          src_path TEXT NOT NULL,
          target_id TEXT,
          target_label TEXT NOT NULL,
          line INTEGER,
          PRIMARY KEY (workspace_slug, src_id, target_label)
        );
        INSERT INTO backlinks_new (workspace_slug, src_id, src_path, target_id, target_label, line)
          SELECT w.slug, b.src_id, b.src_path, b.target_id, b.target_label, b.line
          FROM backlinks b JOIN workspaces w ON w.id = b.workspace_id;
        DROP TABLE backlinks;
        ALTER TABLE backlinks_new RENAME TO backlinks;
        CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (workspace_slug, target_id);
      `);
    }
    if (has("page_tags") && colHas("page_tags", "workspace_id")) {
      db.exec(`
        CREATE TABLE page_tags_new (
          workspace_slug TEXT NOT NULL,
          cosheaf_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (workspace_slug, cosheaf_id, tag)
        );
        INSERT INTO page_tags_new (workspace_slug, cosheaf_id, tag)
          SELECT w.slug, p.cosheaf_id, p.tag
          FROM page_tags p JOIN workspaces w ON w.id = p.workspace_id;
        DROP TABLE page_tags;
        ALTER TABLE page_tags_new RENAME TO page_tags;
      `);
    }
    if (has("notes_fts")) {
      // FTS5 virtual tables can't be ALTERed; rebuild with the new column
      // shape. Body is rebuildable via `pnpm cli workspace reindex <slug>`
      // (which is the recommended post-migration step), so we don't try to
      // preserve content here — joining FTS rows to workspaces and rewriting
      // them would be fragile and slow.
      db.exec(`
        DROP TABLE notes_fts;
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          workspace_slug UNINDEXED,
          cosheaf_id UNINDEXED,
          path,
          title,
          body,
          tokenize='trigram'
        );
      `);
    }
    db.exec("DROP TABLE workspaces;");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Pre-schema migrations: rewrite legacy table shapes before schema.sql's
  // CREATE IF NOT EXISTS would silently leave them in place.
  migrateDropDocKindColumns(db);
  migrateDropWorkspacesTable(db);
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrateDropIssuesSidecar(db);
  migrateBacklinksLine(db);
  dbInstance = db;
  return db;
}
