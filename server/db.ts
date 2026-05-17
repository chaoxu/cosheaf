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
  sessionSecret: string;
  forgejoUrl: string;
  forgejoToken: string;
  forgejoOwner: string;
  webhookSecret: string;
  webhookUrl: string;
}

const DEFAULT_SESSION_SECRET = "dev-secret-change-me";

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
  const sessionSecret = process.env.COSHEAF_SESSION_SECRET ?? DEFAULT_SESSION_SECRET;
  // The session secret derives the AES key that encrypts stored Forgejo PATs.
  // If it changes between restarts (e.g. default → real value), every stored
  // PAT becomes undecryptable and users get force-logged-out. In production
  // that's a foot-gun; warn loudly. In tests the default is fine.
  if (sessionSecret === DEFAULT_SESSION_SECRET && process.env.NODE_ENV === "production") {
    console.error("COSHEAF_SESSION_SECRET is unset in production; refusing to start.");
    process.exit(1);
  }
  if (sessionSecret === DEFAULT_SESSION_SECRET && process.env.NODE_ENV !== "test") {
    console.warn(
      "WARN: COSHEAF_SESSION_SECRET is unset; using the dev default. " +
        "All stored Forgejo PATs are tied to this secret — changing it later forces every user to re-log-in.",
    );
  }
  return {
    dataDir,
    port: Number(process.env.COSHEAF_PORT ?? 3030),
    sessionSecret,
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

// Move users to Forgejo-owned auth: drop cosheaf-side password_hash (login
// goes through Forgejo now), drop forgejo_username (cosheaf username equals
// Forgejo username), add forgejo_token_ciphertext for the encrypted per-user
// PAT. Idempotent; safe on fresh schemas where the new column already exists.
function migrateUsersToForgejoAuth(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('users')").all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some((c) => c.name === name);
  if (has("password_hash")) db.exec("ALTER TABLE users DROP COLUMN password_hash;");
  if (has("forgejo_username")) db.exec("ALTER TABLE users DROP COLUMN forgejo_username;");
  if (!has("forgejo_token_ciphertext")) {
    db.exec("ALTER TABLE users ADD COLUMN forgejo_token_ciphertext BLOB;");
  }
}

function migrateBacklinksLine(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('backlinks')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "line")) {
    db.exec("ALTER TABLE backlinks ADD COLUMN line INTEGER;");
  }
}

function migrateWorkspaceDefaultFormat(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('workspaces')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "default_md_format")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN default_md_format TEXT NOT NULL DEFAULT 'forgejo-passthrough';");
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

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrateDropDocKindColumns(db);
  migrateDropIssuesSidecar(db);
  migrateUsersToForgejoAuth(db);
  migrateBacklinksLine(db);
  migrateWorkspaceDefaultFormat(db);
  dbInstance = db;
  return db;
}
