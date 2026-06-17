// Type definitions for the subset of the Forgejo REST API that cosheaf
// consumes. Split out of forgejo.ts so the client class doesn't drown in
// type defs. Imported by forgejo.ts; route code generally goes through
// shared/ for response shapes, not these directly.

// A bare user reference (id + login) as Forgejo attaches to assignees, activity
// actors, and timeline assign/resolve events — distinct from the full ForgejoUser
// (which also carries avatar_url/email for rendering).
export interface ForgejoUserRef {
  id: number;
  login: string;
}

// The milestone summary embedded on issues and pulls (carries `state`, unlike
// the bare {id,title} on timeline events).
export interface ForgejoMilestoneRef {
  id: number;
  title: string;
  state: "open" | "closed";
}

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  // Full user object (carries avatar_url + email for same-origin avatars, #177).
  user: ForgejoUser | null;
  assignees: ForgejoUserRef[] | null;
  labels: ForgejoLabel[];
  milestone?: ForgejoMilestoneRef | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown; // present (truthy) for PRs; we filter these out
}

export interface ForgejoIssueComment {
  id: number;
  body: string;
  user: ForgejoUser | null;
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
  act_user?: ForgejoUserRef;
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
  user?: ForgejoUser;
  body?: string;
  created_at: string;
  updated_at?: string;
  // Type-specific fields. Forgejo's swagger says these are present on
  // some kinds and not others; we pick out what we use.
  label?: { id: number; name: string; color: string };
  old_title?: string;
  new_title?: string;
  assignee?: ForgejoUserRef;
  // Forgejo serializes ref_issue as a FULL Issue object on pull_ref/commit_ref/
  // comment_ref events (carrying number, title, state, and pull_request when the
  // ref is a PR) — not the bare number the field name suggests.
  ref_issue?: {
    number: number;
    title?: string;
    state?: string;
    pull_request?: { merged?: boolean; merged_at?: string | null } | null;
  } | number | null;
  ref_comment?: { id: number; body: string };
  ref_action?: string;            // "neutral" | "closes" | "reopens"
  ref_commit_sha?: string;
  milestone?: { id: number; title: string };
  dependent_issue?: { id: number; number: number; title: string; state: string };
  resolve_doer?: ForgejoUserRef;
  removed_assignee?: boolean;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
  exclusive?: boolean;
  is_archived?: boolean;
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
  description?: string;
  website?: string;
  location?: string;
  active?: boolean;
  is_admin?: boolean;
  // Always present: a custom upload, else a generated identicon whose hash is
  // md5(lowercase(email)) — see hasCustomAvatar in routes/avatar.ts (#150).
  avatar_url?: string;
}

/** Stand-in login when a Forgejo response has `user: null`. */
export const DELETED_USER_LOGIN = "(deleted)";

// Resolve a Forgejo user's login, substituting the deleted-user sentinel when
// the user object is null/undefined. Centralizes the `user?.login ?? …`
// fallback the API routes apply when shaping author fields.
export function userLogin(user: { login: string } | null | undefined): string {
  return user?.login ?? DELETED_USER_LOGIN;
}

// Forgejo serves ISO-8601 dates; the Cosheaf DTO wire shape is epoch-ms. Two
// conversions so each field matches its DTO type: `toEpochMs` for required
// `number` fields (0 on absent/unparseable), `toEpochMsOrNull` for nullable
// (`number | null`) fields (null preserved). Use the matching one per field — a
// nullable field must NOT collapse to 0.
export function toEpochMs(value: string | null | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}
export function toEpochMsOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
export interface ForgejoRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  description?: string;
  private?: boolean;
  owner: ForgejoUser;
  // Present when the search/list endpoints include topics; the dedicated
  // /topics endpoint (Forgejo client `listRepoTopics`) is the authoritative
  // read otherwise.
  topics?: string[];
  // Included by Forgejo when listing/getting repos with an authenticated
  // user — saves an extra `getRepoPermission` round-trip per repo.
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  // Repo-overview stats Forgejo includes on getRepo (issues-only count; PRs are
  // counted separately). Used by the repo-home header.
  updated_at?: string;
  open_issues_count?: number;
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
  labels?: ForgejoLabel[];
  milestone?: ForgejoMilestoneRef | null;
  requested_reviewers?: ForgejoUser[];
  requested_reviewers_teams?: Array<{ id: number; name: string; username?: string }>;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string };
  user: ForgejoUser | null;
  comments?: number;
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

export interface ForgejoCommit {
  sha: string;
  html_url?: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  author?: ForgejoUser | null;
  committer?: ForgejoUser | null;
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
