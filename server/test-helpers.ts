import type Database from "better-sqlite3";
import type { Role } from "../shared/roles.js";
import type { Config } from "./db.js";
import { _seedBearerAuthCacheForTests, _seedPermCacheForTests } from "./middleware.js";

// After #63, cosheaf has no users table and no session cookie. The bearer
// cache and the workspace permission cache are seeded directly so route
// tests don't need a live Forgejo. The returned token is the bearer the
// test should send in `Authorization: Bearer <token>`. The `id` and any
// `Database` argument are kept only for call-site compatibility with the
// previous helper signature and are otherwise unused.
export function seedAuthUser(
  _db: Database.Database,
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
  _seedBearerAuthCacheForTests(token, opts.username);
  if (opts.role) {
    _seedPermCacheForTests(
      opts.owner ?? config.forgejoOwner,
      // seedTestWorkspace's default slug is "w"; slug ≡ repo name (#60),
      // so the perm-cache key uses the same value.
      opts.repo ?? "w",
      opts.username,
      opts.role,
    );
  }
  return token;
}
