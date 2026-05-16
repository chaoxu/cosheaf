import type Database from "better-sqlite3";
import type { BranchState } from "../shared/change-lifecycle.js";
import { generateDocId } from "./ids.js";

export interface BranchRow {
  id: string;
  workspace_id: number;
  author_user_id: number;
  branch_name: string;
  state: BranchState;
  pr_number: number | null;
  base_sha: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export function branchNameForId(id: string): string {
  return `change/${id}`;
}

export function getBranchRow(db: Database.Database, workspaceId: number, id: string): BranchRow | null {
  const row = db
    .prepare("SELECT * FROM branches WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, id) as BranchRow | undefined;
  return row ?? null;
}

export function getBranchByPr(db: Database.Database, workspaceId: number, prNumber: number): BranchRow | null {
  const row = db
    .prepare("SELECT * FROM branches WHERE workspace_id = ? AND pr_number = ?")
    .get(workspaceId, prNumber) as BranchRow | undefined;
  return row ?? null;
}

export function listOpenDraftsForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): BranchRow[] {
  return db
    .prepare(
      "SELECT * FROM branches WHERE workspace_id = ? AND author_user_id = ? AND state = 'draft' ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as BranchRow[];
}

export function listWritableForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): BranchRow[] {
  return db
    .prepare(
      "SELECT * FROM branches WHERE workspace_id = ? AND author_user_id = ? AND state IN ('draft', 'changes_requested') ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as BranchRow[];
}

export function listOpenForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): BranchRow[] {
  return db
    .prepare(
      "SELECT * FROM branches WHERE workspace_id = ? AND author_user_id = ? AND state IN ('draft', 'review', 'changes_requested') ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as BranchRow[];
}

export function listInReview(db: Database.Database, workspaceId: number): BranchRow[] {
  return db
    .prepare(
      "SELECT * FROM branches WHERE workspace_id = ? AND state = 'review' ORDER BY updated_at DESC",
    )
    .all(workspaceId) as BranchRow[];
}

export function createBranchRow(db: Database.Database, opts: {
  workspaceId: number;
  authorUserId: number;
  baseSha: string | null;
  title?: string | null;
}): BranchRow {
  const id = generateDocId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO branches (id, workspace_id, author_user_id, branch_name, state, base_sha, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).run(id, opts.workspaceId, opts.authorUserId, branchNameForId(id), opts.baseSha, opts.title ?? null, now, now);
  return getBranchRow(db, opts.workspaceId, id) as BranchRow;
}

export function setBranchState(
  db: Database.Database,
  workspaceId: number,
  id: string,
  state: BranchState,
  patch?: { pr_number?: number | null; title?: string | null },
): void {
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const args: unknown[] = [state, Date.now()];
  if (patch && "pr_number" in patch) { sets.push("pr_number = ?"); args.push(patch.pr_number); }
  if (patch && "title" in patch) { sets.push("title = ?"); args.push(patch.title); }
  args.push(workspaceId, id);
  db.prepare(`UPDATE branches SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`).run(...args);
}

export function deleteBranchRow(db: Database.Database, workspaceId: number, id: string): void {
  db.prepare("DELETE FROM branches WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
}
