import type Database from "better-sqlite3";
import { clearRepoConfig } from "./repo-config.js";

// Delete every sidecar row for a workspace. Shared by the workspace-rm
// CLI (admin teardown) and the repository-deleted webhook handler
// (reconciliation when Forgejo loses the repo).
export function deleteSidecarForWorkspace(db: Database.Database, workspaceSlug: string): void {
  db.prepare("DELETE FROM doc_map WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM notes_fts WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM backlinks WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM xref_targets WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM xref_target_duplicates WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM citation_targets WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM page_tags WHERE workspace_slug = ?").run(workspaceSlug);
  db.prepare("DELETE FROM issue_claims WHERE workspace_slug = ?").run(workspaceSlug);
  clearRepoConfig(db, workspaceSlug);
}
