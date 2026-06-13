import type { ForgejoRepo } from "./forgejo.js";
import { allDocumentFormats } from "./format-registry.js";
import { normalizeDocumentFormatId, topicForDocumentFormat } from "../shared/document-format.js";
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

// Every repo the calling token can see that carries a `cosheaf-format-*`
// topic, in any owner's namespace. Forgejo repo search runs under the
// caller's PAT, so private repos respect Forgejo visibility. Topic search is
// exact-match only, so we run one search per registered format (the registry
// is the single source of truth for which formats exist) and union by full
// name.
export async function listVisibleWorkspaceRepos(
  fj: { searchReposByTopic(topic: string): Promise<ForgejoRepo[]> },
): Promise<ForgejoRepo[]> {
  const results = await Promise.all(
    allDocumentFormats().map((f) =>
      fj.searchReposByTopic(topicForDocumentFormat(normalizeDocumentFormatId(f.id))),
    ),
  );
  const byFullName = new Map<string, ForgejoRepo>();
  for (const repo of results.flat()) byFullName.set(repo.full_name, repo);
  return [...byFullName.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}
