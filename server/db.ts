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
  // Non-site-admin runtime token. This is the token name exposed in normal
  // app env and should not carry Forgejo site-admin privileges.
  forgejoToken: string;
  // Site-admin/provisioning token. Keep its usage limited to explicit
  // provisioning, webhook reconciliation, and operator CLI paths.
  forgejoAdminToken: string;
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
    forgejoAdminToken: required("COSHEAF_FORGEJO_ADMIN_TOKEN"),
    forgejoOwner: withDefault("COSHEAF_FORGEJO_OWNER", "cosheaf-admin"),
    webhookSecret: required("COSHEAF_WEBHOOK_SECRET"),
    webhookUrl: withDefault("COSHEAF_WEBHOOK_URL", "http://127.0.0.1:3030/api/v1/webhooks/forgejo"),
  };
}

let dbInstance: Database.Database | null = null;

// Legacy sidecar tables keyed off `workspace_id INTEGER` (FK into the old
// `workspaces` table) get rewritten to key off `workspace_slug TEXT`. We
// detect the legacy shape and migrate in place, preserving rows by joining
// through the workspaces table while it still exists, then drop it.
//
// Older migrations (doc_type/forgejo_kind column drop, issues sidecar drop,
// backlinks.line add) were retired — every live cosheaf DB has long since
// run them. If you're hitting a fresh-import error from a pre-May-17 DB,
// the recovery is `rm $COSHEAF_DATA_DIR/db.sqlite && pnpm setup:dev`; the
// sidecar is rebuildable from Forgejo.
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
  // Pre-schema migration: rewrite legacy `workspace_id INTEGER` tables to
  // `workspace_slug TEXT` before schema.sql's CREATE IF NOT EXISTS would
  // silently leave them in place.
  migrateDropWorkspacesTable(db);
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  dbInstance = db;
  return db;
}
