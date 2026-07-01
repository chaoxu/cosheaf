// Pure mapping layer for the local Workbench CollaborationClient (#262/#263):
// the `*Shape` aliases derived structurally from CollaborationClient, plus the
// `*ToShape` functions that map the core's narrower Cosheaf DTOs back up to the
// forge-client object shapes the collaboration routes consume. Split out of
// origin-collaboration-client.ts so the class file holds only the HTTP client.
// Forge-name-free by the Workbench boundary rule: the only seam reference here
// is the CollaborationClient type, exactly as in origin-collaboration-client.ts.

import type { LineComment } from "../../shared/comments.js";
import type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  NotificationRow,
  TimelineEvent,
} from "../../shared/issues.js";
import { parseWorkspaceSlug } from "../../shared/conventions.js";
import type { PrCommit, PrFile, PrMeta } from "../../shared/review.js";
import type { CollaborationClient } from "../collaboration-client.js";

// The forge-client object shapes, derived from the CollaborationClient surface so
// no forge type is named in this Workbench file. Each is the element the matching
// read method resolves to.
export type IssueShape = Awaited<ReturnType<CollaborationClient["getIssue"]>>;
export type CommentShape = Awaited<ReturnType<CollaborationClient["listIssueComments"]>>[number];
export type LabelShape = Awaited<ReturnType<CollaborationClient["listLabels"]>>[number];
export type MilestoneShape = Awaited<ReturnType<CollaborationClient["listMilestones"]>>[number];
export type TimelineShape = Awaited<ReturnType<CollaborationClient["listIssueTimeline"]>>[number];
// pulls / reviews / repo / notifications surfaces (this pass).
export type PullShape = NonNullable<Awaited<ReturnType<CollaborationClient["getPull"]>>>;
export type ReviewShape = Awaited<ReturnType<CollaborationClient["listReviews"]>>[number];
export type PullFileShape = Awaited<ReturnType<CollaborationClient["listPullFiles"]>>[number];
export type PullCommitShape = Awaited<ReturnType<CollaborationClient["listPullCommits"]>>[number];
export type PullCommentShape = Awaited<ReturnType<CollaborationClient["listPullComments"]>>[number];
export type CollaboratorShape = Awaited<ReturnType<CollaborationClient["listCollaborators"]>>[number];
export type ReviewerShape = Awaited<ReturnType<CollaborationClient["listPullReviewers"]>>[number];
export type ActivityShape = Awaited<ReturnType<CollaborationClient["listRepoActivities"]>>[number];
export type BranchShape = Awaited<ReturnType<CollaborationClient["listBranches"]>>[number];
export type RepoShape = NonNullable<Awaited<ReturnType<CollaborationClient["getRepo"]>>>;
export type BranchProtectionShape = NonNullable<Awaited<ReturnType<CollaborationClient["getBranchProtection"]>>>;
export type NotificationThreadShape = Awaited<ReturnType<CollaborationClient["listRepoNotifications"]>>[number];

// Cosheaf DTOs serialize timestamps as epoch-ms; the forge shapes carry ISO-8601
// strings (which the routes immediately re-parse with toEpochMs). Round-trip
// faithfully: 0 → the epoch, which re-parses back to 0.
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

// Cosheaf Label DTO → label shape. `scope` has no forge-shape equivalent and the
// issue routes don't read it, so it's dropped.
export function toLabelShape(label: Label): LabelShape {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    exclusive: label.exclusive,
    is_archived: label.is_archived,
  };
}

// The compact list-row DTO carries no body/assignees/milestone/closed_at; the
// issue routes' toIssueRow doesn't read those, so synthesize empties.
export function issueRowToShape(row: IssueRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: { id: 0, login: row.author_username },
    assignees: null,
    labels: row.labels.map(toLabelShape),
    milestone: null,
    comments: row.comment_count,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    closed_at: null,
    // pull_request omitted: the typed API is issue-only, so the routes'
    // !pull_request filter passes.
  };
}

export function issueDetailToShape(d: IssueDetail): IssueShape {
  return {
    id: d.number,
    number: d.number,
    title: d.title,
    body: d.body,
    state: d.state,
    user: { id: 0, login: d.author_username },
    assignees: d.assignees.map((login) => ({ id: 0, login })),
    labels: d.labels.map(toLabelShape),
    // The detail DTO exposes only {id,title}; milestone.state isn't read by the
    // issue routes (they take {id,title}), so default it.
    milestone: d.milestone ? { id: d.milestone.id, title: d.milestone.title, state: "open" } : null,
    comments: d.comment_count,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    closed_at: isoOrNull(d.closed_at),
  };
}

// Build an issue shape from the compact create/edit response. The issue write
// routes read only number/title/body/state off the returned object; the rest
// default like the other compact mappers.
export function writtenIssueToShape(d: { number: number; title: string; body?: string; state: "open" | "closed" }): IssueShape {
  return {
    id: d.number,
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    state: d.state,
    user: null,
    assignees: null,
    labels: [],
    milestone: null,
    comments: 0,
    created_at: "",
    updated_at: "",
    closed_at: null,
  };
}

// The pinned DTO is compact (no labels/created_at/body); routes that consume
// pinned issues read number/title/state/comments/updated_at/author only.
export interface PinnedRow {
  number: number;
  title: string;
  state: "open" | "closed";
  comment_count: number;
  updated_at: number;
  author_username: string;
}
export function pinnedRowToShape(row: PinnedRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: { id: 0, login: row.author_username },
    assignees: null,
    labels: [],
    milestone: null,
    comments: row.comment_count,
    created_at: iso(row.updated_at),
    updated_at: iso(row.updated_at),
    closed_at: null,
  };
}

// Dependency/block rows carry only number/title/state/is_pr; the routes'
// toDependencyRow reads exactly those (is_pr via !!pull_request).
export function dependencyRowToShape(row: DependencyRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: null,
    assignees: null,
    labels: [],
    milestone: null,
    comments: 0,
    created_at: "",
    updated_at: "",
    closed_at: null,
    pull_request: row.is_pr ? {} : undefined,
  };
}

export function commentToShape(cm: IssueComment): CommentShape {
  return {
    id: cm.id,
    body: cm.body,
    user: { id: 0, login: cm.author_username },
    created_at: iso(cm.created_at),
    updated_at: iso(cm.updated_at),
  };
}

export function milestoneToShape(m: Milestone): MilestoneShape {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    state: m.state,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: isoOrNull(m.due_on),
    // created_at is required on the shape but unread by toMilestone.
    created_at: "",
  };
}

export function timelineToShape(e: TimelineEvent): TimelineShape {
  return {
    id: e.id,
    type: e.type,
    user: e.author_username ? { id: 0, login: e.author_username } : undefined,
    body: e.body ?? undefined,
    created_at: iso(e.created_at),
    updated_at: e.updated_at === null ? undefined : iso(e.updated_at),
    label: e.label ? { id: 0, name: e.label.name, color: e.label.color } : undefined,
    old_title: e.old_title ?? undefined,
    new_title: e.new_title ?? undefined,
    assignee: e.assignee ? { id: 0, login: e.assignee } : undefined,
    removed_assignee: e.removed_assignee,
    // Routes read ref_issue.pull_request (null/object) + .merged. Invert the
    // flattened is_pull/pull_merged the DTO carries.
    ref_issue: e.ref_issue
      ? {
          number: e.ref_issue.number,
          title: e.ref_issue.title ?? undefined,
          state: e.ref_issue.state ?? undefined,
          pull_request: e.ref_issue.is_pull ? { merged: e.ref_issue.pull_merged ?? false } : null,
        }
      : undefined,
    ref_action: e.ref_action ?? undefined,
    ref_commit_sha: e.ref_commit_sha ?? undefined,
    milestone: e.milestone ? { id: 0, title: e.milestone } : undefined,
    dependent_issue: e.dependent_issue
      ? { id: 0, number: e.dependent_issue.number, title: e.dependent_issue.title, state: e.dependent_issue.state }
      : undefined,
  };
}

// ----- pulls / reviews -----

// The typed PR DTO drops the forge pull `id`, the issue-style comment count, and
// `updated_at`; the pull surfaces don't read `id`/`updated_at` and render the
// missing comment count as 0 (its own list-row fallback). head `label` is unread.
export function prMetaToPullShape(p: PrMeta): PullShape {
  return {
    id: 0,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: isoOrNull(p.merged_at),
    mergeable: p.mergeable,
    additions: p.additions_total,
    deletions: p.deletions_total,
    changed_files: p.files_changed,
    labels: p.labels.map(toLabelShape),
    milestone: p.milestone ? { id: p.milestone.id, title: p.milestone.title, state: "open" } : null,
    requested_reviewers: p.requested_reviewers.map((login) => ({ id: 0, login })),
    requested_reviewers_teams: p.requested_reviewer_teams.map((name) => ({ id: 0, name })),
    head: { ref: p.head_ref, sha: p.head_sha, label: "" },
    base: { ref: p.base_ref, sha: p.base_sha },
    user: { id: 0, login: p.author_username },
    comments: p.comment_count,
    created_at: iso(p.created_at),
    updated_at: iso(p.created_at),
  };
}

// The typed reviews endpoint flattens to a verdict DTO. It pre-filters out
// DISMISSED and other users' PENDING reviews, but DOES surface the CALLER'S OWN
// pending (draft) review as decision "pending" so the staged pending-review flow
// can resolve the draft here (#262). Re-expand `decision` to the forge review
// state the timeline + requireOwnPendingReview read; `comment` (nullable)
// becomes the review body.
export interface ReviewDto {
  id: number;
  username: string;
  decision: "approve" | "request_changes" | "comment" | "pending";
  comment: string | null;
  created_at: number;
}
export function reviewDtoToShape(r: ReviewDto): ReviewShape {
  const state =
    r.decision === "approve"
      ? "APPROVED"
      : r.decision === "request_changes"
        ? "REQUEST_CHANGES"
        : r.decision === "pending"
          ? "PENDING"
          : "COMMENT";
  return {
    id: r.id,
    body: r.comment ?? "",
    state,
    user: { id: 0, login: r.username },
    submitted_at: iso(r.created_at),
  };
}

// The typed PR-commits DTO is flat (sha/message/author_username/author_name/
// date-as-epoch-ms); rebuild the nested commit shape the pull timeline reads:
// sha, commit.message, commit.author.{name,date}, and author.login. A null
// author/date leaves the corresponding fields empty.
export function prCommitToShape(commit: PrCommit): PullCommitShape {
  return {
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: {
        name: commit.author_name ?? undefined,
        date: commit.date === null ? undefined : iso(commit.date),
      },
    },
    author: commit.author_username ? { id: 0, login: commit.author_username } : null,
  };
}

export function prFileToShape(f: PrFile): PullFileShape {
  return {
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    previous_filename: f.previous_path,
  };
}

// Invert the typed comment DTO's resolved (line, side) back into the forge's
// absolute position / original_position so the route's resolveLineComment
// re-derives the same anchor: head → position, base → original_position; an
// outdated comment (line === null) leaves both at 0. commit/diff_hunk fields are
// unread by the PR routes.
export function lineCommentToShape(cm: LineComment): PullCommentShape {
  const position = cm.side === "head" && cm.line !== null ? cm.line : 0;
  const original = cm.side === "base" && cm.line !== null ? cm.line : 0;
  return {
    id: cm.id,
    pull_request_review_id: cm.review_id,
    path: cm.path,
    body: cm.body,
    position,
    original_position: original,
    commit_id: "",
    original_commit_id: "",
    diff_hunk: "",
    user: { id: 0, login: cm.author_username },
    created_at: iso(cm.created_at),
    updated_at: iso(cm.updated_at),
  };
}

// The /branches list returns a branch object (the local content backend's
// WsBranch, plus a commit `url`); the pull/settings surfaces read only `name`.
export interface BranchJson {
  name: string;
  commit?: { id?: string; timestamp?: string; author?: { username?: string; name?: string; email?: string } };
}
export function branchToShape(b: BranchJson): BranchShape {
  return { name: b.name, commit: { id: b.commit?.id ?? "", timestamp: b.commit?.timestamp, author: b.commit?.author } };
}

// ----- notifications -----

// NotificationRow is already the mapped repo-notification DTO; rebuild the
// thread shape the notification routes re-map. The typed feed is unread-only, so
// `unread` is true and `pinned` false. Synthesize a subject url carrying the
// issue/pull number so the routes' number-from-url parse still resolves.
export function notificationRowToShape(row: NotificationRow): NotificationThreadShape {
  const type = row.kind === "pr" ? "Pull" : "Issue";
  const segment = row.kind === "pr" ? "pulls" : "issues";
  const name = parseWorkspaceSlug(row.repo)?.repo ?? row.repo;
  return {
    id: row.id,
    unread: true,
    pinned: false,
    updated_at: iso(row.updated_at),
    url: "",
    subject: {
      title: row.title,
      url: `/${segment}/${row.number}`,
      latest_comment_url: "",
      html_url: row.url,
      type,
    },
    repository: { full_name: row.repo, name },
  };
}

// The typed collaborators DTO is {login, permission}; the settings route reads
// only `login` off each member. `permission` has no consumer here and is dropped.
export function collaboratorToShape(member: { login: string; permission: string }): CollaboratorShape {
  return { id: 0, login: member.login };
}

// The typed /activities DTO is the already-collapsed ActivityRow (flat fields
// the core extracted from the forge's JSON-ish `content`). The activity page
// re-collapses and re-parses `content`, so rebuild a minimal `content` from the
// flattened fields its parsers actually read: a commit ref ({Commits:[{Sha1,
// Message}]}) when a commit sha survives, otherwise the [index, label] array the
// pull/issue ref parsers expect. `repeat_count` is unreconstructable through the
// local re-collapse and is dropped (documented #263 lossy field); the consumer
// .catch-degrades on any gap.
export function activityRowToShape(a: ActivityRow): ActivityShape {
  let content: string | undefined;
  if (a.commit_sha) {
    content = JSON.stringify({ Commits: [{ Sha1: a.commit_sha, Message: a.commit_message ?? "" }] });
  } else if (a.ref_index !== null) {
    content = JSON.stringify([a.ref_index, a.comment_body ?? ""]);
  }
  return {
    id: a.id,
    op_type: a.op_type,
    act_user: a.author_username ? { id: 0, login: a.author_username } : undefined,
    ref_name: a.ref_name ?? undefined,
    content,
    created: iso(a.created_at),
  };
}
