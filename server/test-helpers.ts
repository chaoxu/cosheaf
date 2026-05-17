import type Database from "better-sqlite3";
import type { Role } from "../shared/roles.js";
import type { Config } from "./db.js";
import { _seedBearerAuthCacheForTests, _seedPermCacheForTests } from "./middleware.js";
import { encryptPat } from "./pat-crypto.js";

export function seedAuthUser(
  db: Database.Database,
  config: Config,
  opts: {
    id?: number;
    username: string;
    role?: Role;
    owner?: string;
    repo?: string;
  },
): string {
  const token = `fake-pat-${opts.username}`;
  const blob = encryptPat(`fake-pat-${opts.username}`, config.sessionSecret);
  if (opts.id === undefined) {
    db.prepare(
      "INSERT INTO users (username, forgejo_token_ciphertext, created_at) VALUES (?, ?, 0)",
    ).run(opts.username, blob);
  } else {
    db.prepare(
      "INSERT INTO users (id, username, forgejo_token_ciphertext, created_at) VALUES (?, ?, ?, 0)",
    ).run(opts.id, opts.username, blob);
  }
  _seedBearerAuthCacheForTests(token, opts.username);
  if (opts.role) {
    _seedPermCacheForTests(
      opts.owner ?? config.forgejoOwner,
      opts.repo ?? "repo",
      opts.username,
      opts.role,
    );
  }
  return token;
}
