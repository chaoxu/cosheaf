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

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  ensureTrigramFts(db);
  dbInstance = db;
  return db;
}
