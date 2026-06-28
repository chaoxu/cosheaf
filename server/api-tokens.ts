import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface ResolvedApiToken {
  username: string;
  forgejoToken: string;
}

export function createApiToken(): string {
  return `cosheaf_${randomBytes(32).toString("base64url")}`;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function storeApiToken(db: Database.Database, token: string, username: string, forgejoToken: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO api_tokens (token_hash, username, forgejo_pat, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      username = excluded.username,
      forgejo_pat = excluded.forgejo_pat,
      last_used_at = excluded.last_used_at
  `).run(hashApiToken(token), username, forgejoToken, now, now);
}

export function resolveApiToken(db: Database.Database, token: string): ResolvedApiToken | null {
  const row = db.prepare(`
    SELECT username, forgejo_pat
    FROM api_tokens
    WHERE token_hash = ?
  `).get(hashApiToken(token)) as { username: string; forgejo_pat: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), hashApiToken(token));
  return { username: row.username, forgejoToken: row.forgejo_pat };
}

export function deleteApiToken(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM api_tokens WHERE token_hash = ?").run(hashApiToken(token));
}
