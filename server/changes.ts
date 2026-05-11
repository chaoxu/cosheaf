import type Database from "better-sqlite3";
import type { ChangeState } from "../shared/change-lifecycle.js";
import { generateDocId } from "./frontmatter.js";

export interface ChangeRow {
  id: string;
  workspace_id: number;
  author_user_id: number;
  branch_name: string;
  state: ChangeState;
  pr_number: number | null;
  base_sha: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export function branchForChange(id: string): string {
  return `change/${id}`;
}

export function getChange(db: Database.Database, workspaceId: number, id: string): ChangeRow | null {
  const row = db
    .prepare("SELECT * FROM changes WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, id) as ChangeRow | undefined;
  return row ?? null;
}

export function getChangeByPr(db: Database.Database, workspaceId: number, prNumber: number): ChangeRow | null {
  const row = db
    .prepare("SELECT * FROM changes WHERE workspace_id = ? AND pr_number = ?")
    .get(workspaceId, prNumber) as ChangeRow | undefined;
  return row ?? null;
}

export function listOpenDraftsForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): ChangeRow[] {
  return db
    .prepare(
      "SELECT * FROM changes WHERE workspace_id = ? AND author_user_id = ? AND state = 'draft' ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as ChangeRow[];
}

export function listWritableForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): ChangeRow[] {
  return db
    .prepare(
      "SELECT * FROM changes WHERE workspace_id = ? AND author_user_id = ? AND state IN ('draft', 'changes_requested') ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as ChangeRow[];
}

export function listOpenForUser(
  db: Database.Database,
  workspaceId: number,
  userId: number,
): ChangeRow[] {
  return db
    .prepare(
      "SELECT * FROM changes WHERE workspace_id = ? AND author_user_id = ? AND state IN ('draft', 'review', 'changes_requested') ORDER BY updated_at DESC",
    )
    .all(workspaceId, userId) as ChangeRow[];
}

export function listInReview(db: Database.Database, workspaceId: number): ChangeRow[] {
  return db
    .prepare(
      "SELECT * FROM changes WHERE workspace_id = ? AND state = 'review' ORDER BY updated_at DESC",
    )
    .all(workspaceId) as ChangeRow[];
}

export function createChange(db: Database.Database, opts: {
  workspaceId: number;
  authorUserId: number;
  baseSha: string | null;
  title?: string | null;
}): ChangeRow {
  const id = generateDocId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO changes (id, workspace_id, author_user_id, branch_name, state, base_sha, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).run(id, opts.workspaceId, opts.authorUserId, branchForChange(id), opts.baseSha, opts.title ?? null, now, now);
  return getChange(db, opts.workspaceId, id) as ChangeRow;
}

export function setChangeState(
  db: Database.Database,
  workspaceId: number,
  id: string,
  state: ChangeState,
  patch?: { pr_number?: number | null; title?: string | null },
): void {
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const args: unknown[] = [state, Date.now()];
  if (patch && "pr_number" in patch) { sets.push("pr_number = ?"); args.push(patch.pr_number); }
  if (patch && "title" in patch) { sets.push("title = ?"); args.push(patch.title); }
  args.push(workspaceId, id);
  db.prepare(`UPDATE changes SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`).run(...args);
}

export function deleteChange(db: Database.Database, workspaceId: number, id: string): void {
  db.prepare("DELETE FROM changes WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
}
