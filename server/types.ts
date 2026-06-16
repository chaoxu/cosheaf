import type Database from "better-sqlite3";
import type { User } from "./users.js";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import type { SSEHub } from "./sse.js";
import type { Role } from "../shared/roles.js";
import type { LocaleId, T } from "../shared/i18n/index.js";

export interface WorkspaceContext {
  // Forgejo repo owner (user or org) and repo name — the workspace identity.
  owner: string;
  repo: string;
  // Slug is the canonical workspace identifier: the Forgejo `owner/repo`
  // full name. It is what sidecar tables key off (workspace_slug column)
  // and what SSE channels are named after.
  slug: string;
  defaultMdFormat: string;
  role: Role;
}

// Per-request bundle handed to workspace-scoped routes. `fj` is bound to the
// authenticated user's Forgejo PAT — there is no admin token at runtime and
// no impersonation header to forget.
export interface RepoCtx {
  fj: Forgejo;
  owner: string;
  repo: string;
}

export interface AppEnv {
  Variables: {
    // Per-request correlation id (hono/request-id): echoed in the
    // X-Request-Id response header and included in error logs.
    requestId: string;
    db: Database.Database;
    config: Config;
    // Admin-bound Forgejo client. Used only by the webhook handler and
    // explicit provisioning paths; normal workspace routes use user PATs.
    fjAdmin: Forgejo;
    sse: SSEHub;
    // Per-request UI locale (resolved once in middleware from the cosheaf_lang
    // cookie / Accept-Language) and a locale-bound translate. Threaded
    // explicitly to renderers — no AsyncLocalStorage.
    locale: LocaleId;
    t: T;
    user: User;
    // Forgejo client bound to the authenticated user's PAT. Set by
    // requireAuth; used by every workspace route via repoCtx.fj.
    fjUser: Forgejo;
    forgejoToken: string;
    workspace: WorkspaceContext;
    repoCtx: RepoCtx;
  };
}
