import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  dataDir: string;
  port: number;
  sessionSecret: string;
}

export function loadConfig(): Config {
  const dataDir = process.env.COSHEAF_DATA_DIR ?? path.resolve(process.cwd(), "data");
  const port = Number(process.env.COSHEAF_PORT ?? 3030);
  const sessionSecret = process.env.COSHEAF_SESSION_SECRET ?? "dev-secret-change-me";
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, "workspaces"), { recursive: true });
  return { dataDir, port, sessionSecret };
}

let dbInstance: Database.Database | null = null;

export function getDb(config: Config): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(config.dataDir, "db.sqlite");
  const db = new Database(dbPath);
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
  dbInstance = db;
  return db;
}

function migrate(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(approvals)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "comment")) {
    db.exec("ALTER TABLE approvals ADD COLUMN comment TEXT");
  }
}

export function workspaceDir(config: Config, slug: string): string {
  return path.join(config.dataDir, "workspaces", slug);
}
