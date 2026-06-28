// Local Workbench mode helpers (config.mode === "local").
//
// The Workbench reuses the hosted routes and islands, but its identity and
// authorization come from the launcher (a single on-disk folder), not a forge.
// These helpers are the local branch of the shared auth/membership resolvers:
// they fabricate the fixed local user and the single admin workspace without
// any forge call. Forge-free by construction.

import type { Context } from "hono";
import { workspaceSlug } from "../../shared/conventions.js";
import type { AppEnv, LocalWorkspaceIdentity, WorkspaceContext } from "../types.js";

// True when this process is the local Workbench.
export function isLocalMode(c: Context<AppEnv>): boolean {
  return c.get("config").mode === "local";
}

// The WorkspaceContext for a local request, or null when owner/repo don't match
// the single workspace this Workbench serves (the caller turns that into a 404).
// The local user is always `admin` on their own folder.
export function localWorkspaceContext(
  id: LocalWorkspaceIdentity,
  owner: string,
  repo: string,
): WorkspaceContext | null {
  if (owner !== id.owner || repo !== id.repo) return null;
  return {
    owner,
    repo,
    slug: workspaceSlug(owner, repo),
    defaultMdFormat: id.defaultMdFormat,
    role: "admin",
  };
}
