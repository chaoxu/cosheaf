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
