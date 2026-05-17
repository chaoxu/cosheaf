import type Database from "better-sqlite3";
import type { Forgejo } from "./forgejo.js";
import { ForgejoError } from "./forgejo.js";

// Delete every sidecar row for a workspace. `workspaces` is parent-FK to
// doc_map (ON DELETE CASCADE handles that one); backlinks, page_tags, and
// notes_fts don't carry the FK so they need explicit deletes. Shared by the
// workspace-rm CLI (admin teardown) and the repository-deleted webhook
// handler (reconciliation when Forgejo loses the repo).
export function deleteSidecarForWorkspace(db: Database.Database, workspaceId: number): void {
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  db.prepare("DELETE FROM notes_fts WHERE workspace_id = ?").run(workspaceId);
  db.prepare("DELETE FROM backlinks WHERE workspace_id = ?").run(workspaceId);
  db.prepare("DELETE FROM page_tags WHERE workspace_id = ?").run(workspaceId);
}

// Forgejo.deleteBranch with 404-tolerance — used in PR-merge cleanup and the
// typed DELETE /branches route. Both call sites want "ensure the branch is
// gone; don't fail if it was already gone."
export async function deleteBranchQuietly(
  fj: Forgejo,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  try {
    await fj.deleteBranch(owner, repo, branch);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) {
      console.warn(`deleteBranch ${branch}: ${(err as Error).message}`);
    }
  }
}
