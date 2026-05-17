import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptPat, encryptPat } from "./pat-crypto.js";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
// Cosheaf user. Username is also the Forgejo username — login validates
// directly against Forgejo and stores a per-user PAT (encrypted) for later
// API calls. There is no cosheaf-side password.
export interface User {
  id: number;
  username: string;
}

function readUser(db: Database.Database, where: string, ...args: unknown[]): User | null {
  const row = db
    .prepare(`SELECT id, username FROM users WHERE ${where}`)
    .get(...args) as User | undefined;
  return row ?? null;
}

export function findUserByUsername(db: Database.Database, username: string): User | null {
  return readUser(db, "username = ?", username);
}
export function findUserById(db: Database.Database, id: number): User | null {
  return readUser(db, "id = ?", id);
}

// Create or get the user row for a freshly authenticated Forgejo identity.
// Called from the login route after Forgejo accepted the credentials, so
// `username` is already proven against Forgejo.
export function upsertUserFromForgejo(db: Database.Database, username: string): User {
  const existing = readUser(db, "username = ?", username);
  if (existing) return existing;
  return db
    .prepare(
      "INSERT INTO users (username, created_at) VALUES (?, ?) RETURNING id, username",
    )
    .get(username, Date.now()) as User;
}

export function setStoredPat(
  db: Database.Database,
  userId: number,
  pat: string,
  sessionSecret: string,
): void {
  const blob = encryptPat(pat, sessionSecret);
  db.prepare("UPDATE users SET forgejo_token_ciphertext = ? WHERE id = ?").run(blob, userId);
}

export function getStoredPat(
  db: Database.Database,
  userId: number,
  sessionSecret: string,
): string | null {
  const row = db
    .prepare("SELECT forgejo_token_ciphertext AS blob FROM users WHERE id = ?")
    .get(userId) as { blob: Buffer | null } | undefined;
  if (!row?.blob) return null;
  try {
    return decryptPat(row.blob, sessionSecret);
  } catch (err) {
    // Bad ciphertext: key rotated (SESSION_SECRET changed), tamper, or
    // truncated row. Log so ops can tell an environment misconfiguration
    // apart from "user just needs to log in again." Don't log the bytes.
    console.warn(`getStoredPat decrypt failed for user ${userId}: ${(err as Error).message}`);
    return null;
  }
}

// Sessions

export function createSession(db: Database.Database, userId: number): string {
  const id = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, now, now + SESSION_TTL_MS);
  return id;
}
export function destroySession(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
