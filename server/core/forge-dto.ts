import type { BranchRow } from "../../shared/branches.js";
import type { Label, DependencyRow, IssueComment, IssueDetail, IssueRow, Milestone, NotificationKind, NotificationRow, TimelineEvent, UserRef } from "../../shared/issues.js";
import type { LineComment } from "../../shared/comments.js";
import type { PrCommit, PrFile, PrFileStatus, PrMeta, ReviewDto } from "../../shared/review.js";
import type {
  ForgejoBranch,
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoNotificationThread,
  ForgejoPull,
  ForgejoPullFile,
  ForgejoPullReviewComment,
  ForgejoReview,
  ForgejoTimelineEvent,
  ForgejoUser,
} from "../forgejo-types.js";
import { toEpochMs, toEpochMsOrNull, userLogin } from "../forgejo-types.js";

export function forgeBranchToRow(branch: ForgejoBranch): BranchRow {
  return {
    name: branch.name,
    commit: {
      id: branch.commit.id,
      timestamp: branch.commit.timestamp,
      author: branch.commit.author,
    },
  };
}

function userRef(user: ForgejoUser | null | undefined): UserRef | undefined {
  if (!user) return undefined;
  return {
    login: user.login,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
    ...(user.email ? { email: user.email } : {}),
  };
}

function labelScope(label: ForgejoLabel): string | null {
  if (!label.exclusive) return null;
  const slash = label.name.lastIndexOf("/");
  return slash > 0 ? label.name.slice(0, slash) : null;
}

export function toLabel(label: ForgejoLabel): Label {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    exclusive: Boolean(label.exclusive),
    is_archived: Boolean(label.is_archived),
    scope: labelScope(label),
  };
}

export function forgeIssueToRow(i: ForgejoIssue): IssueRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author_username: userLogin(i.user),
    author: userRef(i.user),
    labels: i.labels.map(toLabel),
    comment_count: i.comments,
    created_at: toEpochMs(i.created_at),
    updated_at: toEpochMs(i.updated_at),
  };
}

export function forgeIssueToDetail(i: ForgejoIssue): IssueDetail {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    author_username: userLogin(i.user),
    author: userRef(i.user),
    assignees: (i.assignees ?? []).map((a) => a.login),
    labels: i.labels.map(toLabel),
    milestone: i.milestone ? { id: i.milestone.id, title: i.milestone.title } : null,
    comment_count: i.comments,
    created_at: toEpochMs(i.created_at),
    updated_at: toEpochMs(i.updated_at),
    closed_at: toEpochMsOrNull(i.closed_at),
  };
}

export function forgeIssueCommentToDto(cm: ForgejoIssueComment): IssueComment {
  return {
    id: cm.id,
    body: cm.body,
    author_username: userLogin(cm.user),
    author: userRef(cm.user),
    created_at: toEpochMs(cm.created_at),
    updated_at: toEpochMs(cm.updated_at),
  };
}

export function forgeMilestoneToDto(milestone: ForgejoMilestone): Milestone {
  return {
    id: milestone.id,
    title: milestone.title,
    description: milestone.description ?? "",
    state: milestone.state,
    open_issues: milestone.open_issues,
    closed_issues: milestone.closed_issues,
    due_on: toEpochMsOrNull(milestone.due_on),
  };
}

export function forgeIssueToDependencyRow(i: ForgejoIssue): DependencyRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    is_pr: !!i.pull_request,
  };
}

export function forgeRefIssueToDto(
  ref: ForgejoTimelineEvent["ref_issue"],
): TimelineEvent["ref_issue"] {
  if (!ref || typeof ref !== "object") return null;
  return {
    number: ref.number,
    title: ref.title ?? null,
    state: ref.state ?? null,
    is_pull: ref.pull_request != null,
    pull_merged: ref.pull_request ? ref.pull_request.merged ?? false : null,
  };
}

export function forgeTimelineEventToDto(e: ForgejoTimelineEvent): TimelineEvent {
  return {
    id: e.id,
    type: e.type,
    author_username: e.user?.login ?? null,
    author: userRef(e.user) ?? null,
    body: e.body ?? null,
    created_at: toEpochMs(e.created_at),
    updated_at: toEpochMsOrNull(e.updated_at),
    label: e.label ? { name: e.label.name, color: e.label.color } : null,
    old_title: e.old_title ?? null,
    new_title: e.new_title ?? null,
    assignee: e.assignee?.login ?? null,
    removed_assignee: e.removed_assignee ?? false,
    ref_issue: forgeRefIssueToDto(e.ref_issue),
    ref_action: e.ref_action ?? null,
    ref_commit_sha: e.ref_commit_sha ?? null,
    milestone: e.milestone?.title ?? null,
    dependent_issue: e.dependent_issue
      ? { number: e.dependent_issue.number, title: e.dependent_issue.title, state: e.dependent_issue.state }
      : null,
  };
}

export function normalizePrFileStatus(s: string): PrFileStatus {
  if (s === "added" || s === "modified" || s === "deleted" || s === "renamed" || s === "copied") return s;
  return "modified";
}

export function forgePullToMeta(pull: ForgejoPull): PrMeta {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state === "closed" ? "closed" : "open",
    merged: pull.merged ?? false,
    author_username: userLogin(pull.user),
    created_at: toEpochMs(pull.created_at),
    merged_at: toEpochMsOrNull(pull.merged_at),
    mergeable: pull.mergeable ?? null,
    head_ref: pull.head.ref,
    head_sha: pull.head.sha,
    base_ref: pull.base.ref,
    base_sha: pull.base.sha,
    additions_total: pull.additions ?? 0,
    deletions_total: pull.deletions ?? 0,
    files_changed: pull.changed_files ?? 0,
    comment_count: pull.comments ?? 0,
    labels: (pull.labels ?? []).map(toLabel),
    milestone: pull.milestone ? { id: pull.milestone.id, title: pull.milestone.title } : null,
    requested_reviewers: (pull.requested_reviewers ?? []).map((u) => u.login),
    requested_reviewer_teams: (pull.requested_reviewers_teams ?? []).map((t) => t.username ?? t.name),
  };
}

export function forgeCommitToPrCommit(commit: ForgejoCommit): PrCommit {
  return {
    sha: commit.sha,
    message: commit.commit.message,
    author_username: commit.author?.login ?? null,
    author_name: commit.commit.author?.name ?? null,
    date: toEpochMsOrNull(commit.commit.author?.date),
  };
}

export function forgeReviewToDto(r: ForgejoReview): ReviewDto {
  return {
    id: r.id,
    username: userLogin(r.user),
    decision:
      r.state === "APPROVED"
        ? "approve"
        : r.state === "REQUEST_CHANGES"
          ? "request_changes"
          : r.state === "PENDING"
            ? "pending"
            : r.state === "DISMISSED"
              ? "dismissed"
              : "comment",
    comment: r.body || null,
    created_at: toEpochMs(r.submitted_at),
  };
}

export function forgePullFileToStatus(file: ForgejoPullFile): PrFileStatus {
  return normalizePrFileStatus(file.status);
}

export function forgePullFileToDto(file: ForgejoPullFile, patch = ""): PrFile {
  return {
    path: file.filename,
    previous_path: file.previous_filename,
    status: normalizePrFileStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    patch,
  };
}

export function forgePullCommentToDto(
  cm: ForgejoPullReviewComment,
  resolved: Pick<LineComment, "line" | "side" | "outdated">,
): LineComment {
  return {
    id: cm.id,
    review_id: cm.pull_request_review_id,
    path: cm.path,
    line: resolved.line,
    side: resolved.side,
    body: cm.body,
    author_username: userLogin(cm.user),
    created_at: toEpochMs(cm.created_at),
    updated_at: toEpochMs(cm.updated_at),
    outdated: resolved.outdated,
  };
}

// Parse "/api/v1/repos/owner/repo/issues/42" or ".../pulls/42" -> 42.
function numberFromSubjectUrl(url: string): number | null {
  const m = url.match(/\/(?:issues|pulls)\/(\d+)(?:[?#]|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function forgeNotificationThreadToRow(thread: ForgejoNotificationThread): NotificationRow | null {
  const subjectType = thread.subject.type;
  const kind: NotificationKind | null = subjectType === "Issue" ? "issue" : subjectType === "Pull" ? "pr" : null;
  if (!kind) return null;
  const number = numberFromSubjectUrl(thread.subject.url);
  if (number === null) return null;
  return {
    id: thread.id,
    kind,
    number,
    title: thread.subject.title,
    repo: thread.repository.full_name,
    updated_at: toEpochMs(thread.updated_at),
    url: thread.subject.html_url ?? thread.subject.url,
  };
}

export function forgeNotificationThreadsToRows(threads: readonly ForgejoNotificationThread[]): NotificationRow[] {
  return threads
    .map(forgeNotificationThreadToRow)
    .filter((row): row is NotificationRow => row !== null)
    .sort((a, b) => b.updated_at - a.updated_at);
}
