import type { ForgejoRepo } from "./forgejo.js";
import {
  COFLAT_FORMAT_ID,
  FORGEJO_PASSTHROUGH_FORMAT_ID,
  type DocumentFormatId,
  topicForDocumentFormat,
} from "../shared/document-format.js";

// Every repo the calling token can see that carries a `cosheaf-format-*`
// topic, in any owner's namespace. Forgejo repo search runs under the
// caller's PAT, so private repos respect Forgejo visibility. Topic search is
// exact-match only, so we run one search per registered format and union by
// full name.
export async function listVisibleWorkspaceRepos(
  fj: { searchReposByTopic(topic: string): Promise<ForgejoRepo[]> },
): Promise<ForgejoRepo[]> {
  const formatIds: DocumentFormatId[] = [COFLAT_FORMAT_ID, FORGEJO_PASSTHROUGH_FORMAT_ID];
  const results = await Promise.all(
    formatIds.map((id) => fj.searchReposByTopic(topicForDocumentFormat(id))),
  );
  const byFullName = new Map<string, ForgejoRepo>();
  for (const repo of results.flat()) byFullName.set(repo.full_name, repo);
  return [...byFullName.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}
