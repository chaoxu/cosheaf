import type { Label, DependencyRow, IssueComment, IssueRow, Milestone, TimelineEvent } from "../../shared/issues.js";
import type { PrCommit, PrFileStatus, PrMeta, ReviewDto } from "../../shared/review.js";
import type {
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoPull,
  ForgejoPullFile,
  ForgejoReview,
  ForgejoTimelineEvent,
} from "../forgejo-types.js";
import { toEpochMs, toEpochMsOrNull, userLogin } from "../forgejo-types.js";

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
    labels: i.labels.map(toLabel),
    comment_count: i.comments,
    created_at: toEpochMs(i.created_at),
    updated_at: toEpochMs(i.updated_at),
  };
}

export function forgeIssueCommentToDto(cm: ForgejoIssueComment): IssueComment {
  return {
    id: cm.id,
    body: cm.body,
    author_username: userLogin(cm.user),
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
            : "comment",
    comment: r.body || null,
    created_at: toEpochMs(r.submitted_at),
  };
}

export function forgePullFileToStatus(file: ForgejoPullFile): PrFileStatus {
  return normalizePrFileStatus(file.status);
}
