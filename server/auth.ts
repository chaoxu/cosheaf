import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
