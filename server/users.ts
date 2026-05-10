import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { ForgejoError, type Forgejo } from "./forgejo.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "cs_";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function hashPassword(p: string): Promise<string> {
  return hash(p);
}
export async function verifyPassword(p: string, h: string): Promise<boolean> {
  return verify(h, p);
}

export interface User {
  id: number;
  username: string;
  forgejo_username: string | null;
}

function readUser(db: Database.Database, where: string, ...args: unknown[]): User | null {
  const row = db
    .prepare(`SELECT id, username, forgejo_username FROM users WHERE ${where}`)
    .get(...args) as User | undefined;
  return row ?? null;
}

export function findUserByUsername(db: Database.Database, username: string): (User & { password_hash: string }) | null {
  const row = db
    .prepare("SELECT id, username, forgejo_username, password_hash FROM users WHERE username = ?")
    .get(username) as (User & { password_hash: string }) | undefined;
  return row ?? null;
}
export function findUserById(db: Database.Database, id: number): User | null {
  return readUser(db, "id = ?", id);
}

export function createUser(db: Database.Database, username: string, passwordHash: string): User {
  return db
    .prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, username, forgejo_username",
    )
    .get(username, passwordHash, Date.now()) as User;
}

export function setUserPassword(db: Database.Database, username: string, passwordHash: string): boolean {
  return db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(passwordHash, username).changes > 0;
}

export function setForgejoUsername(db: Database.Database, userId: number, forgejoUsername: string): void {
  db.prepare("UPDATE users SET forgejo_username = ? WHERE id = ?").run(forgejoUsername, userId);
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
      "SELECT users.id AS id, users.username AS username, users.forgejo_username AS forgejo_username, sessions.expires_at AS expires_at " +
        "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?",
    )
    .get(sessionId) as (User & { expires_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, sessionId);
    return null;
  }
  return { id: row.id, username: row.username, forgejo_username: row.forgejo_username };
}

// Tokens

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
      "SELECT users.id AS id, users.username AS username, users.forgejo_username AS forgejo_username " +
        "FROM tokens JOIN users ON users.id = tokens.user_id WHERE tokens.token_hash = ?",
    )
    .get(tokenHash) as User | undefined;
  return row ?? null;
}

// Forgejo proxy

function forgejoUsernameFor(cosheafUsername: string): string {
  // Forgejo usernames allow letters, digits, dashes, underscores, dots; must start with alnum.
  // Cosheaf usernames are already a strict subset, but be safe.
  const cleaned = cosheafUsername.replace(/[^A-Za-z0-9._-]/g, "_");
  return `cs-${cleaned}`;
}

export async function ensureForgejoProxy(
  db: Database.Database,
  forgejo: Forgejo,
  user: User,
): Promise<string> {
  if (user.forgejo_username) return user.forgejo_username;
  const fjName = forgejoUsernameFor(user.username);
  const existing = await forgejo.getUserByName(fjName);
  if (!existing) {
    const password = randomBytes(24).toString("base64url");
    try {
      await forgejo.createUser({
        username: fjName,
        email: `${fjName}@cosheaf.local`,
        password,
      });
    } catch (err) {
      // Concurrent first-login can race two creates; treat 409/422 as "someone else won".
      if (!(err instanceof ForgejoError && (err.status === 409 || err.status === 422))) throw err;
    }
  }
  setForgejoUsername(db, user.id, fjName);
  return fjName;
}
