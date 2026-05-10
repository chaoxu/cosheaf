import type Database from "better-sqlite3";
import type { User } from "./users.js";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import type { SSEHub } from "./sse.js";

export type Role = "owner" | "verifier" | "member";

export interface WorkspaceContext {
  id: number;
  slug: string;
  name: string;
  forgejoRepo: string;
  role: Role;
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
  };
}
