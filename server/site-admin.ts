import type Database from "better-sqlite3";
import type { Config } from "./db.js";

const FIRST_SITE_ADMIN = "chao";
const REGISTRATION_OPEN_KEY = "registration_open";

type SiteSettingRow = { value: string };

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
