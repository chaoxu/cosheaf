// Mirror Forgejo issues into the SQLite sidecar so the sidebar lists can
// answer "issues assigned to me" / "open issues for this workspace" without
// hitting Forgejo on every render.

import type Database from "better-sqlite3";
import type { Forgejo, ForgejoIssue } from "./forgejo.js";

export interface IndexedIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  author_login: string;
  author_user_id: number | null;
  labels: string[];
  comment_count: number;
  created_at: number;
  updated_at: number;
}

function userIdForLogin(db: Database.Database, login: string): number | null {
  const row = db
    .prepare("SELECT id FROM users WHERE forgejo_username = ?")
    .get(login) as { id: number } | undefined;
  return row?.id ?? null;
}

export function upsertIssue(
  db: Database.Database,
  workspaceId: number,
  issue: ForgejoIssue,
): void {
  if (issue.pull_request) return; // skip PRs — they live in `changes`
  const authorId = userIdForLogin(db, issue.user.login);
  const labels = JSON.stringify(issue.labels.map((l) => l.name));
  db.prepare(
    `INSERT INTO issues (workspace_id, number, forgejo_id, title, state, author_user_id, author_login, labels, comment_count, created_at, updated_at)
     VALUES (@workspace_id, @number, @forgejo_id, @title, @state, @author_user_id, @author_login, @labels, @comment_count, @created_at, @updated_at)
     ON CONFLICT (workspace_id, number) DO UPDATE SET
       title = excluded.title,
       state = excluded.state,
       labels = excluded.labels,
       comment_count = excluded.comment_count,
       updated_at = excluded.updated_at`,
  ).run({
    workspace_id: workspaceId,
    number: issue.number,
    forgejo_id: issue.id,
    title: issue.title,
    state: issue.state,
    author_user_id: authorId,
    author_login: issue.user.login,
    labels,
    comment_count: issue.comments,
    created_at: new Date(issue.created_at).getTime(),
    updated_at: new Date(issue.updated_at).getTime(),
  });
  // Replace assignees.
  db.prepare("DELETE FROM issue_assignees WHERE workspace_id = ? AND number = ?").run(
    workspaceId, issue.number,
  );
  if (issue.assignees) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO issue_assignees (workspace_id, number, user_id) VALUES (?, ?, ?)",
    );
    for (const a of issue.assignees) {
      const uid = userIdForLogin(db, a.login);
      if (uid !== null) insert.run(workspaceId, issue.number, uid);
    }
  }
}

export function deleteIssue(db: Database.Database, workspaceId: number, number: number): void {
  db.prepare("DELETE FROM issue_assignees WHERE workspace_id = ? AND number = ?").run(workspaceId, number);
  db.prepare("DELETE FROM issues WHERE workspace_id = ? AND number = ?").run(workspaceId, number);
}

export async function reindexAllIssues(
  db: Database.Database,
  forgejo: Forgejo,
  owner: string,
  repo: string,
  workspaceId: number,
): Promise<number> {
  let count = 0;
  for (let page = 1; page < 100; page++) {
    const batch = await forgejo.listIssues(owner, repo, { state: "all", page, limit: 50 });
    if (batch.length === 0) break;
    for (const issue of batch) upsertIssue(db, workspaceId, issue);
    count += batch.length;
    if (batch.length < 50) break;
  }
  return count;
}

export function listIssues(
  db: Database.Database,
  workspaceId: number,
  filter: {
    state?: "open" | "closed" | "all";
    assigneeUserId?: number;
    authorUserId?: number;
    q?: string;
  } = {},
): IndexedIssue[] {
  const state = filter.state ?? "open";
  const conditions: string[] = ["i.workspace_id = ?"];
  const params: (string | number)[] = [workspaceId];
  if (state !== "all") {
    conditions.push("i.state = ?");
    params.push(state);
  }
  let join = "";
  if (filter.assigneeUserId !== undefined) {
    join = "JOIN issue_assignees a ON a.workspace_id = i.workspace_id AND a.number = i.number";
    conditions.push("a.user_id = ?");
    params.push(filter.assigneeUserId);
  }
  if (filter.authorUserId !== undefined) {
    conditions.push("i.author_user_id = ?");
    params.push(filter.authorUserId);
  }
  if (filter.q && filter.q.trim()) {
    conditions.push("i.title LIKE ? ESCAPE '\\'");
    const pat = `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(pat);
  }
  const rows = db
    .prepare(
      `SELECT i.number, i.title, i.state, i.author_login, i.author_user_id, i.labels, i.comment_count, i.created_at, i.updated_at
       FROM issues i
       ${join}
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.updated_at DESC`,
    )
    .all(...params) as Array<{
      number: number;
      title: string;
      state: "open" | "closed";
      author_login: string;
      author_user_id: number | null;
      labels: string;
      comment_count: number;
      created_at: number;
      updated_at: number;
    }>;
  return rows.map((r) => ({ ...r, labels: JSON.parse(r.labels) as string[] }));
}
