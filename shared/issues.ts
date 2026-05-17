// Response shapes for the issues / notifications / activity surface.
// Shared by the server (which constructs these from Forgejo objects) and
// the client (which types fetches against them). Single source of truth so
// the two can't drift.

export interface Label {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface IssueRow {
  number: number;
  title: string;
  state: "open" | "closed";
  author_username: string;
  labels: string[];
  comment_count: number;
  created_at: number;
  updated_at: number;
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author_username: string;
  assignees: string[];
  labels: Label[];
  milestone: { id: number; title: string } | null;
  comment_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface IssueComment {
  id: number;
  body: string;
  author_username: string;
  created_at: number;
  updated_at: number;
}

export interface Milestone {
  id: number;
  title: string;
  description: string;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on: number | null;
}

export interface DependencyRow {
  number: number;
  title: string;
  state: "open" | "closed";
  is_pr: boolean;
}

export interface TimelineEvent {
  id: number;
  type: string;
  author_username: string | null;
  body: string | null;
  created_at: number;
  updated_at: number | null;
  label: { name: string; color: string } | null;
  old_title: string | null;
  new_title: string | null;
  assignee: string | null;
  removed_assignee: boolean;
  ref_issue: number | null;
  ref_action: string | null;
  ref_commit_sha: string | null;
  milestone: string | null;
  dependent_issue: { number: number; title: string; state: string } | null;
}

export interface ActivityRow {
  id: number;
  op_type: string;
  actor: string | null;
  ref_index: number | null;
  ref_name: string | null;
  comment_body: string | null;
  created_at: number;
}

export interface NotificationRow {
  id: number;
  kind: "issue" | "pr";
  number: number;
  title: string;
  repo: string;
  updated_at: number;
  url: string;
}
