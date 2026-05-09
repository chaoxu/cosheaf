import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "cs_";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(password: string, hashStr: string): Promise<boolean> {
  return verify(hashStr, password);
}

export interface User {
  id: number;
  username: string;
}

export function createUser(db: Database.Database, username: string, passwordHash: string): User {
  const stmt = db.prepare(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, username",
  );
  return stmt.get(username, passwordHash, Date.now()) as User;
}

export function findUserByUsername(db: Database.Database, username: string): (User & { password_hash: string }) | null {
  const stmt = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?");
  return (stmt.get(username) as (User & { password_hash: string }) | undefined) ?? null;
}

export function findUserById(db: Database.Database, id: number): User | null {
  const stmt = db.prepare("SELECT id, username FROM users WHERE id = ?");
  return (stmt.get(id) as User | undefined) ?? null;
}

export function setUserPassword(db: Database.Database, username: string, passwordHash: string): boolean {
  const stmt = db.prepare("UPDATE users SET password_hash = ? WHERE username = ?");
  return stmt.run(passwordHash, username).changes > 0;
}

export function createSession(db: Database.Database, userId: number): string {
  const id = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(id, userId, now, now + SESSION_TTL_MS);
  return id;
}

export function destroySession(db: Database.Database, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function userFromSession(db: Database.Database, sessionId: string): User | null {
  const row = db
    .prepare(
      "SELECT users.id AS id, users.username AS username, sessions.expires_at AS expires_at " +
        "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?",
    )
    .get(sessionId) as (User & { expires_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, sessionId);
    return null;
  }
  return { id: row.id, username: row.username };
}

export interface TokenRow {
  id: number;
  name: string;
  created_at: number;
}

/** Returns the cleartext token (only chance to see it) and its row id. */
export function createToken(
  db: Database.Database,
  userId: number,
  name: string,
): { token: string; id: number } {
  const secret = randomBytes(24).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  const tokenHash = sha256Hex(token);
  const result = db
    .prepare(
      "INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(userId, name, tokenHash, Date.now()) as { id: number };
  return { token, id: result.id };
}

export function listTokens(db: Database.Database, userId: number): TokenRow[] {
  return db
    .prepare("SELECT id, name, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as TokenRow[];
}

export function revokeToken(
  db: Database.Database,
  userId: number,
  tokenId: number,
): boolean {
  return (
    db.prepare("DELETE FROM tokens WHERE id = ? AND user_id = ?").run(tokenId, userId).changes > 0
  );
}

export function userFromToken(db: Database.Database, token: string): User | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = sha256Hex(token);
  const row = db
    .prepare(
      "SELECT users.id AS id, users.username AS username " +
        "FROM tokens JOIN users ON users.id = tokens.user_id WHERE tokens.token_hash = ?",
    )
    .get(tokenHash) as User | undefined;
  return row ?? null;
}
