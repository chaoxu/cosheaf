// Legacy mapping layer for the remaining unmigrated local Workbench surfaces
// (#262/#288):
// the `*Shape` aliases derived structurally from CollaborationClient, plus the
// `*ToShape` functions that map the core's narrower Cosheaf DTOs back up to the
// forge-client object shapes the collaboration routes consume. Split out of
// origin-collaboration-client.ts so the class file holds only the HTTP client.
// Forge-name-free by the Workbench boundary rule: the only seam reference here
// is the CollaborationClient type, exactly as in origin-collaboration-client.ts.

import type { LineComment } from "../../shared/comments.js";
import type { ActivityRow, Label } from "../../shared/issues.js";
import type { PrCommit, PrFile, PrMeta, ReviewDto } from "../../shared/review.js";
export type LabelShape = {
  id: number;
  name: string;
  color: string;
  description?: string;
  exclusive?: boolean;
  is_archived?: boolean;
};
import type { CollaborationClient } from "../collaboration-client.js";
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
