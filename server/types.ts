import type Database from "better-sqlite3";
import type { User } from "./auth.js";
import type { Config } from "./db.js";

export interface WorkspaceContext {
  id: number;
  slug: string;
  role: "owner" | "verifier" | "member";
}

export interface AppEnv {
  Variables: {
    db: Database.Database;
    config: Config;
    user: User;
    workspace: WorkspaceContext;
  };
}
