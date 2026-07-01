import type { ForgejoRepo } from "./forgejo.js";
import type { Role } from "../shared/roles.js";

// Map Forgejo's repo `permissions` object (included on list/search results
// for the authenticated user) to a cosheaf Role, or "none" if the user has no
// access. Shared by the workspace-list API and the server-rendered home page.
export function roleFromPermissions(
  p: { admin?: boolean; push?: boolean; pull?: boolean } | undefined,
): Role | "none" {
  if (!p) return "none";
  if (p.admin) return "admin";
  if (p.push) return "write";
  if (p.pull) return "read";
  return "none";
}

// Every repo the calling token can access, in any owner's namespace. Cosheaf
// is a thin frontend over the forge, so discovery shows all repos the caller
// can see — not only ones carrying a `cosheaf-format-*` topic. Markdown is
// always Coflat.
// Forgejo repo search runs under the user's resolved backend credential, so
// private repos respect Forgejo visibility. Dedupe by full name and sort for a
// stable list.
export async function listVisibleWorkspaceRepos(
  fj: { searchAllAccessibleRepos(): Promise<ForgejoRepo[]> },
): Promise<ForgejoRepo[]> {
  const repos = await fj.searchAllAccessibleRepos();
  const byFullName = new Map<string, ForgejoRepo>();
  for (const repo of repos) byFullName.set(repo.full_name, repo);
  return [...byFullName.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}
