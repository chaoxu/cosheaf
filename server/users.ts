import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptPat, encryptPat } from "./pat-crypto.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "cs_";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

// Personal API tokens (cosheaf-side bearer tokens for scripted clients).
//
// These authenticate the bearer as the owning cosheaf user; once
// authenticated, every Forgejo call uses that user's stored, encrypted PAT
// (the same one the browser session uses). So a `cs_…` token holder acts
// with the user's full Forgejo permissions — repo + issue + notification —
// not a reduced cosheaf-only scope. Treat cs_ tokens with the same care as
// the user's Forgejo password.
//
// (If we ever want narrower scripted-client tokens, the right move is to
// mint a separate, scope-reduced Forgejo PAT per cs_ token and use that
// instead of the user's primary PAT. Not implemented yet.)

export interface TokenRow { id: number; name: string; created_at: number }

export function createToken(db: Database.Database, userId: number, name: string): { token: string; id: number } {
  const secret = randomBytes(24).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  const tokenHash = sha256Hex(token);
  const r = db
    .prepare("INSERT INTO tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get(userId, name, tokenHash, Date.now()) as { id: number };
  return { token, id: r.id };
}
export function listTokens(db: Database.Database, userId: number): TokenRow[] {
  return db.prepare("SELECT id, name, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC").all(userId) as TokenRow[];
}
export function revokeToken(db: Database.Database, userId: number, tokenId: number): boolean {
  return db.prepare("DELETE FROM tokens WHERE id = ? AND user_id = ?").run(tokenId, userId).changes > 0;
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
