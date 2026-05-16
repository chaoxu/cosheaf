// Naming + size conventions that span the client/server boundary. These
// constants are the single source of truth for values that previously
// drifted across hard-coded literals — change them here and every call
// site moves in lockstep.

/**
 * Per-user branch namespace. The cosheaf server enforces this prefix when
 * a write auto-creates a branch (so writes can't conjure arbitrary branch
 * names on the user's behalf); the client builds the same prefix when it
 * generates a fresh branch name for first-save. Returns a trailing slash
 * so `${userBranchPrefix(x)}wip-abc` is well-formed.
 */
export function userBranchPrefix(forgejoUsername: string): string {
  return `user/${forgejoUsername}/`;
}

/** Maximum binary asset size accepted by `POST /assets`. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_DISPLAY = "25 MiB";

/**
 * Workspace slug shape. Lowercase, dashes, must start alphanumeric.
 * Validated by both the seed CLI parser and the `POST /workspaces` route.
 */
export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
