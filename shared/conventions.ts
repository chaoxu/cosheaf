// Naming + size conventions that span the client/server boundary. These
// constants are the single source of truth for values that previously
// drifted across hard-coded literals — change them here and every call
// site moves in lockstep.

/**
 * Per-user branch namespace used by browser defaults when first-save needs a
 * fresh branch. Explicit branch names are normal Forgejo branch names; this is
 * only the stable default prefix for user-owned draft work. Returns a trailing
 * slash so `${userBranchPrefix(x)}wip-abc` is well-formed.
 */
export function userBranchPrefix(forgejoUsername: string): string {
  return `user/${forgejoUsername}/`;
}

/** Maximum binary asset size accepted by `POST /assets`. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_DISPLAY = "25 MiB";

/**
 * Repo-name shape for repos cosheaf itself creates. Lowercase, dashes, must
 * start alphanumeric. Validated by both the seed CLI parser and the
 * `POST /workspaces` route. Forgejo accepts a broader class (see
 * FORGEJO_NAME_RE); cosheaf-created repos stay opinionated.
 */
export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Forgejo owner (user/org) and repo names as Forgejo itself accepts them:
 * alphanumeric plus `-`, `_`, `.`, starting alphanumeric or `_`. Used when
 * routing to EXISTING repos — cosheaf must reach any repo Forgejo can host,
 * not only ones matching WORKSPACE_SLUG_RE.
 */
export const FORGEJO_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * Canonical workspace slug: the Forgejo `owner/repo` full name. This is the
 * key for sidecar tables (workspace_slug column), SSE channels, and webhook
 * serialization queues. Forgejo names cannot contain `/`, so the join is
 * unambiguous.
 */
export function workspaceSlug(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/**
 * Per-user SSE channel for cross-repo signals that aren't scoped to one
 * workspace — currently the home inbox liveness hint (#116). Forgejo logins
 * can't contain `/`, and workspace slugs always do, so `user:<login>` never
 * collides with a `workspaceSlug` channel key in the SSE hub.
 */
export function notificationChannel(login: string): string {
  return `user:${login}`;
}

/** Split an `owner/repo` workspace slug. Returns null unless both halves are valid Forgejo names. */
export function parseWorkspaceSlug(slug: string): { owner: string; repo: string } | null {
  const idx = slug.indexOf("/");
  if (idx < 0) return null;
  const owner = slug.slice(0, idx);
  const repo = slug.slice(idx + 1);
  if (!FORGEJO_NAME_RE.test(owner) || !FORGEJO_NAME_RE.test(repo)) return null;
  return { owner, repo };
}
