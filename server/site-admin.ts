import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "./db.js";

const FIRST_SITE_ADMIN = "chao";
const REGISTRATION_OPEN_KEY = "registration_open";

type SiteSettingRow = { value: string };
export interface RegistrationInvite {
  readonly token_hash: string;
  readonly created_by: string;
  readonly created_at: number;
  readonly used_by: string | null;
  readonly used_at: number | null;
}

export function bootstrapSiteAdmins(db: Database.Database): void {
  const row = db.prepare("SELECT 1 FROM site_admins LIMIT 1").get();
  if (row) return;
  db.prepare("INSERT INTO site_admins (username, created_at) VALUES (?, ?)").run(FIRST_SITE_ADMIN, Date.now());
}

export function isSiteAdmin(db: Database.Database, username: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM site_admins WHERE username = ?").get(username));
}

export function effectiveRegistrationOpen(db: Database.Database, config: Config): boolean {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = ?").get(REGISTRATION_OPEN_KEY) as SiteSettingRow | undefined;
  if (!row) return config.registrationOpen;
  return row.value === "open";
}

export function setRegistrationOpen(db: Database.Database, open: boolean, updatedBy: string): void {
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(REGISTRATION_OPEN_KEY, open ? "open" : "closed", Date.now(), updatedBy);
}

export function createRegistrationInvite(db: Database.Database, createdBy: string): string {
  const token = randomBytes(24).toString("base64url");
  db.prepare(`
    INSERT INTO registration_invites (token_hash, created_by, created_at)
    VALUES (?, ?, ?)
  `).run(registrationInviteTokenHash(token), createdBy, Date.now());
  return token;
}

export function registrationInviteForToken(db: Database.Database, token: string | null | undefined): RegistrationInvite | null {
  const normalized = normalizeInviteToken(token);
  if (!normalized) return null;
  const row = db.prepare("SELECT * FROM registration_invites WHERE token_hash = ?").get(registrationInviteTokenHash(normalized)) as RegistrationInvite | undefined;
  if (!row || row.used_at !== null) return null;
  return row;
}

export function reserveRegistrationInvite(db: Database.Database, token: string, username: string): boolean {
  const result = db.prepare(`
    UPDATE registration_invites
    SET used_by = ?, used_at = ?
    WHERE token_hash = ? AND used_at IS NULL
  `).run(username, Date.now(), registrationInviteTokenHash(token));
  return result.changes === 1;
}

export function releaseRegistrationInvite(db: Database.Database, token: string, username: string): void {
  db.prepare(`
    UPDATE registration_invites
    SET used_by = NULL, used_at = NULL
    WHERE token_hash = ? AND used_by = ?
  `).run(registrationInviteTokenHash(token), username);
}

function normalizeInviteToken(token: string | null | undefined): string | null {
  const value = token?.trim();
  if (!value || value.length > 256) return null;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function registrationInviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
