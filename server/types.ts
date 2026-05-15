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

// Materialized inside requireMembership so every workspace-scoped route
// has a single shorthand for the Forgejo client + (owner, repo, sudo)
// tuple. Eliminates ~28 sites of repeated c.get() unpacking and removes
// the "did I remember sudo?" footgun.
export interface RepoCtx {
  fj: Forgejo;
  owner: string;
  repo: string;
  sudo: string;
}

export interface AppEnv {
  Variables: {
    db: Database.Database;
    config: Config;
    forgejo: Forgejo;
    sse: SSEHub;
    user: User;
    forgejoUsername: string;
    workspace: WorkspaceContext;
    repoCtx: RepoCtx;
  };
}
