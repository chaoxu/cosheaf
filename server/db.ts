import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load .env.dev from the repo root if present. Saves callers from having
// to `set -a; source ./.env.dev; set +a` before every CLI / dev invocation.
function loadDotenv(): void {
  const candidates = [
    path.resolve(__dirname, "..", ".env.dev"),
    path.resolve(process.cwd(), ".env.dev"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return; // first match wins
  }
}
loadDotenv();

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

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
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
    sessionSecret: process.env.COSHEAF_SESSION_SECRET ?? "dev-secret-change-me",
    forgejoUrl: withDefault("COSHEAF_FORGEJO_URL", "http://127.0.0.1:3002"),
    forgejoToken: required("COSHEAF_FORGEJO_TOKEN"),
    forgejoOwner: withDefault("COSHEAF_FORGEJO_OWNER", "cosheaf-admin"),
    webhookSecret: required("COSHEAF_WEBHOOK_SECRET"),
    webhookUrl: withDefault("COSHEAF_WEBHOOK_URL", "http://127.0.0.1:3030/api/v1/webhooks/forgejo"),
  };
}

let dbInstance: Database.Database | null = null;

function ensureTrigramFts(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'")
    .get() as { sql: string } | undefined;
  if (!row || /tokenize\s*=\s*'?trigram'?/i.test(row.sql)) return;

  db.exec(`
    CREATE VIRTUAL TABLE notes_fts_new USING fts5(
      workspace_id UNINDEXED,
      cosheaf_id UNINDEXED,
      doc_type UNINDEXED,
      path,
      title,
      body,
      tokenize='trigram'
    );
    INSERT INTO notes_fts_new(rowid, workspace_id, cosheaf_id, doc_type, path, title, body)
      SELECT rowid, workspace_id, cosheaf_id, doc_type, path, title, body FROM notes_fts;
    DROP TABLE notes_fts;
    ALTER TABLE notes_fts_new RENAME TO notes_fts;
  `);
}

function ensureChangeStateCheck(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'changes'")
    .get() as { sql: string } | undefined;
  if (!row) return;
  const needsMigration =
    !row.sql.includes("'changes_requested'") || row.sql.includes("'abandoned'") || row.sql.includes("'rejected'");
  if (!needsMigration) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE changes_new (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      author_user_id INTEGER NOT NULL REFERENCES users(id),
      branch_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'review', 'changes_requested', 'merged', 'closed')),
      pr_number INTEGER,
      base_sha TEXT,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO changes_new(id, workspace_id, author_user_id, branch_name, state, pr_number, base_sha, title, created_at, updated_at)
      SELECT id, workspace_id, author_user_id, branch_name,
             CASE state WHEN 'rejected' THEN 'closed' WHEN 'abandoned' THEN 'closed' ELSE state END,
             pr_number, base_sha, title, created_at, updated_at
        FROM changes;
    DROP TABLE changes;
    ALTER TABLE changes_new RENAME TO changes;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
}

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  ensureChangeStateCheck(db);
  ensureTrigramFts(db);
  dbInstance = db;
  return db;
}
