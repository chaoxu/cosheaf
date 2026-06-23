import type Database from "better-sqlite3";
import type { Role } from "../shared/roles.js";
import type { Config } from "./db.js";
import { _seedBearerAuthCacheForTests, _seedPermCacheForTests } from "./middleware.js";

// After #63, cosheaf has no users table. The bearer cache and the workspace
// permission cache are seeded directly so route tests don't need a live Forgejo.
// The returned token is the PAT the test can send in `Authorization: Bearer
// <token>`. The `id` and any `Database` argument are kept only for call-site
// compatibility with the previous helper signature and are otherwise unused.
export function seedAuthUser(
  _db: Database.Database,
  _config: Config,
  opts: {
    id?: number;
    username: string;
    role?: Role;
    owner?: string;
    repo?: string;
  },
): string {
  const token = `fake-pat-${opts.username}`;
  _seedBearerAuthCacheForTests(token, opts.username);
  if (opts.role) {
    _seedPermCacheForTests(
      // Defaults match seedTestWorkspace's fixture identity (owner "owner",
      // repo "w") so both seams agree on the (owner, repo) perm-cache key.
      opts.owner ?? "owner",
      opts.repo ?? "w",
      opts.username,
      opts.role,
    );
  }
  return token;
}

export function authHeaders(token: string): Record<string, string> {
  return { cookie: `cosheaf_pat=${token}` };
}

export function formHeaders(token: string, contentType = "application/x-www-form-urlencoded"): Record<string, string> {
  return { ...authHeaders(token), "content-type": contentType, origin: "http://localhost" };
}
