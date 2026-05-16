// Type definitions for the subset of the Forgejo REST API that cosheaf
// consumes. Split out of forgejo.ts so the client class doesn't drown in
// type defs. Imported by forgejo.ts; route code generally goes through
// shared/ for response shapes, not these directly.

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: { id: number; login: string } | null;
  assignees: Array<{ id: number; login: string }> | null;
  labels: Array<{ id: number; name: string; color: string }>;
  milestone?: { id: number; title: string; state: "open" | "closed" } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown; // present (truthy) for PRs; we filter these out
}

export interface ForgejoIssueComment {
  id: number;
  body: string;
  user: { id: number; login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface ForgejoMilestone {
  id: number;
  title: string;
  description?: string;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on?: string | null;
  created_at: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface ForgejoActivity {
  id: number;
  op_type: string;
  act_user?: { id: number; login: string };
  repo?: { full_name: string };
  comment_id?: number;
  comment?: { id: number; body: string; issue_url?: string; pull_request_url?: string };
  ref_name?: string;
  content?: string;
  created: string;
}

export interface ForgejoTimelineEvent {
  id: number;
  type: string;
  user?: { id: number; login: string };
  body?: string;
  created_at: string;
  updated_at?: string;
  // Type-specific fields. Forgejo's swagger says these are present on
  // some kinds and not others; we pick out what we use.
  label?: { id: number; name: string; color: string };
  old_title?: string;
  new_title?: string;
  assignee?: { id: number; login: string };
  ref_issue?: number;
  ref_comment?: { id: number; body: string };
  ref_action?: string;            // "neutral" | "closes" | "reopens"
  ref_commit_sha?: string;
  milestone?: { id: number; title: string };
  dependent_issue?: { id: number; number: number; title: string; state: string };
  resolve_doer?: { id: number; login: string };
  removed_assignee?: boolean;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
}

// Forgejo's API returns `user: null` for actions attributed to a deleted
// account (e.g. a comment authored by a user who later deleted themselves).
// Consumers must guard `user?.login` — see `DELETED_USER_LOGIN` below for
// the convention we use to render an unknown author safely.
export interface ForgejoUser {
  id: number;
  login: string;
  full_name?: string;
  email?: string;
  active?: boolean;
}

/** Stand-in login when a Forgejo response has `user: null`. */
export const DELETED_USER_LOGIN = "(deleted)";
export interface ForgejoRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  owner: ForgejoUser;
}
export interface ForgejoNotificationThread {
  id: number;
  unread: boolean;
  pinned: boolean;
  updated_at: string;
  url: string;
  subject: {
    title: string;
    url: string;
    latest_comment_url: string;
    html_url?: string;
    type: "Issue" | "Pull" | "Commit" | string;
    state?: string;
  };
  repository: { full_name: string; name: string };
}
export interface ForgejoBranch {
  name: string;
  commit: {
    id: string;
    timestamp?: string;
    author?: { username?: string; name?: string; email?: string };
    committer?: { username?: string; name?: string; email?: string };
  };
}
export interface ForgejoBranchProtection { branch_name: string; required_approvals: number }
export interface ForgejoHook { id: number; type: string; events: string[] }
export interface ForgejoContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  content?: string;
  encoding?: string;
}
export interface ForgejoFileResponse {
  content: ForgejoContent | null;
  commit: { sha: string };
}
export interface ForgejoTreeEntry { path: string; type: "blob" | "tree" | string; size?: number; sha: string }
export interface ForgejoPull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string };
  user: ForgejoUser | null;
  created_at: string;
  updated_at: string;
}
export interface ForgejoPullFile {
  filename: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
}

export interface ForgejoPullReviewComment {
  id: number;
  pull_request_review_id: number;
  path: string;
  body: string;
  position: number | null;
  original_position: number | null;
  commit_id: string;
  original_commit_id: string;
  diff_hunk: string;
  user: ForgejoUser | null;
  created_at: string;
  updated_at: string;
}
export interface ForgejoReview {
  id: number;
  body: string;
  state: "APPROVED" | "REQUEST_CHANGES" | "COMMENT" | "PENDING" | string;
  user: ForgejoUser | null;
  submitted_at?: string;
}
