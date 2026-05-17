import type Database from "better-sqlite3";
import type { User } from "./users.js";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import type { SSEHub } from "./sse.js";
import type { Role } from "../shared/roles.js";

export interface WorkspaceContext {
  id: number;
  slug: string;
  name: string;
  forgejoRepo: string;
  role: Role;
}

// Per-request bundle handed to workspace-scoped routes. `fj` is bound to the
// authenticated user's Forgejo PAT — there is no admin token at runtime and
// no Sudo header to forget.
export interface RepoCtx {
  fj: Forgejo;
  owner: string;
  repo: string;
}

export interface AppEnv {
  Variables: {
    db: Database.Database;
    config: Config;
    // Admin-bound Forgejo client. Used only by the webhook handler and
    // provisioning paths; never on a user-facing request handler.
    fjAdmin: Forgejo;
    sse: SSEHub;
    user: User;
    // Forgejo client bound to the authenticated user's PAT. Set by
    // requireAuth; used by every workspace route via repoCtx.fj.
    fjUser: Forgejo;
    workspace: WorkspaceContext;
    repoCtx: RepoCtx;
  };
}
