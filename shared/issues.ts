// Response shapes for the issues / notifications / activity surface.
// Shared by the server (which constructs these from Forgejo objects) and
// the client (which types fetches against them). Single source of truth so
// the two can't drift.

// The issue lifecycle state (kept separate from review.ts's PrState, which
// documents PR-specific merged-vs-closed semantics).
export type IssueState = "open" | "closed";

export interface Label {
  id: number;
  name: string;
  color: string;
  description?: string;
  exclusive: boolean;
  is_archived: boolean;
  scope: string | null;
}

// An optional live-work lease on an issue (#95). Pure coordination state, not
// durable knowledge: it expires and carries no Forgejo source. Lets concurrent
// runners avoid duplicating work on the same issue.
export interface IssueClaim {
  id: string;
  issue_number: number;
  runner_name: string;
  purpose: string;
  holder_username: string;
  created_at: number;
  heartbeat_at: number;
  expires_at: number;
}

export interface IssueRow {
  number: number;
  title: string;
  state: IssueState;
  author_username: string;
  labels: Label[];
  comment_count: number;
  created_at: number;
  updated_at: number;
  /** Active non-expired live-work leases (#95); omitted when none. */
  claims?: IssueClaim[];
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author_username: string;
  assignees: string[];
  labels: Label[];
  milestone: { id: number; title: string } | null;
  comment_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  /** Active non-expired live-work leases (#95); omitted when none. */
  claims?: IssueClaim[];
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
  state: IssueState;
  open_issues: number;
  closed_issues: number;
  due_on: number | null;
}

export interface DependencyRow {
  number: number;
  title: string;
  state: IssueState;
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
  // The issue/PR that referenced this one on a ref event (pull_ref/commit_ref/
  // comment_ref). `is_pull` + `pull_merged` make PR-caused state changes
  // machine-readable: a `pull_ref` event with `ref_action:"closes"` and
  // `ref_issue.is_pull:true` names the closing PR; pair it with a terminal
  // `merge_pull`/`close` event to tell "closed by an accepted PR" from a manual
  // close. Thin pass-through of Forgejo's timeline — the client correlates the
  // ref and close events by order (#93).
  ref_issue: {
    number: number;
    title: string | null;
    state: string | null;
    is_pull: boolean;
    pull_merged: boolean | null;
  } | null;
  ref_action: string | null;
  ref_commit_sha: string | null;
  milestone: string | null;
  dependent_issue: { number: number; title: string; state: string } | null;
}

export interface ActivityRow {
  id: number;
  op_type: string;
  author_username: string | null;
  ref_index: number | null;
  ref_name: string | null;
  comment_body: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  repeat_count: number;
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
