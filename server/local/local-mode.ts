// Local Workbench mode helpers (config.mode === "local").
//
// The Workbench reuses the hosted routes and islands, but its identity and
// authorization come from the registry of opened folders, not a forge. These
// helpers are the local branch of the shared auth/membership resolvers: they
// resolve the requested owner/repo to a registered workspace and fabricate the
// fixed local user without any forge call. Forge-free by construction.

import { workspaceSlug } from "../../shared/conventions.js";
import type { WebCtx } from "../routes/web-context.js";
import type { WorkspaceContext } from "../types.js";
import type { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.js";

// The web ctx's backend is always the resolved workspace's
// LocalGitWorkspaceBackend in local mode (resolveWebRepo sets it); narrow to
// reach the Tier-0/1 git ops. Shared by the local commit / remote / agent-session
// routers.
export function localBackend(ctx: WebCtx): LocalGitWorkspaceBackend {
  return ctx.backend as LocalGitWorkspaceBackend;
}

// Resolve a request's owner/repo to a registered workspace + its WorkspaceContext,
// or null when no folder is registered under that slug (the caller turns that
// into a 404). The local user is always `admin` on their own folders.
export function resolveLocalWorkspace(
  registry: WorkspaceRegistry,
  owner: string,
  repo: string,
): { entry: WorkspaceEntry; ws: WorkspaceContext } | null {
  const slug = workspaceSlug(owner, repo);
  const entry = registry.get(slug);
  if (!entry) return null;
  return {
    entry,
    ws: {
      owner,
      repo,
      slug,
      defaultMdFormat: entry.identity.defaultMdFormat,
      role: "admin",
    },
  };
}
