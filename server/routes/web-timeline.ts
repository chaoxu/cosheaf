import type { ForgejoTimelineEvent } from "../forgejo-types.js";
import { escapeHtml } from "./html-escape.js";

export interface WebTimelineSortItem {
  kind: "comment" | "event" | "review" | "line-comment" | "commit";
  ts: number;
  event?: Pick<ForgejoTimelineEvent, "id" | "type">;
  review?: { id: number };
  comment?: { id: number };
  commit?: { sha: string };
}

export function webTimelineDescriptionHtml(event: ForgejoTimelineEvent): string {
  const description = webTimelineDescriptionText(event);
  return description ? escapeHtml(description) : "";
}

export function compareWebTimelineItems(a: WebTimelineSortItem, b: WebTimelineSortItem): number {
  const byTimestamp = a.ts - b.ts;
  if (byTimestamp !== 0) return byTimestamp;
  const byRank = timelineTieRank(a) - timelineTieRank(b);
  if (byRank !== 0) return byRank;
  const aId = timelineNumericId(a);
  const bId = timelineNumericId(b);
  if (aId !== null && bId !== null && aId !== bId) return aId - bId;
  return timelineStringId(a).localeCompare(timelineStringId(b));
}

export function webTimelineDescriptionText(event: ForgejoTimelineEvent): string {
  switch (event.type) {
    case "close":
      return "closed this";
    case "reopen":
      return "reopened this";
    case "merge":
      return "merged this";
    case "label":
      return event.label ? `added the ${event.label.name} label` : "changed labels";
    case "unlabel":
      return event.label ? `removed the ${event.label.name} label` : "changed labels";
    case "assignees":
      return event.assignee
        ? `${event.removed_assignee ? "unassigned" : "assigned"} ${event.assignee.login}`
        : "changed assignees";
    case "change_title":
      return `renamed from "${event.old_title ?? ""}" to "${event.new_title ?? ""}"`;
    case "milestone":
      return event.milestone ? `added this to milestone ${event.milestone.title}` : "changed milestone";
    case "demilestone":
      return event.milestone ? `removed this from milestone ${event.milestone.title}` : "changed milestone";
    case "commit_ref":
      return event.ref_commit_sha ? `referenced this in commit ${event.ref_commit_sha.slice(0, 10)}` : "referenced this";
    case "issue_ref":
    case "comment_ref":
      return refIssueNumber(event) ? `referenced this in #${refIssueNumber(event)}` : "referenced this";
    case "pull_ref":
      return refIssueNumber(event) ? `referenced this in pull request #${refIssueNumber(event)}` : "referenced this in a pull request";
    case "dependency_added":
      return event.dependent_issue ? `added dependency #${event.dependent_issue.number}` : "added dependency";
    case "dependency_removed":
      return event.dependent_issue ? `removed dependency #${event.dependent_issue.number}` : "removed dependency";
    case "pin":
      return "pinned this";
    case "unpin":
      return "unpinned this";
    default:
      return event.type.replaceAll("_", " ");
  }
}

function refIssueNumber(event: ForgejoTimelineEvent): number | null {
  const ref = event.ref_issue as unknown;
  if (typeof ref === "number") return ref;
  if (ref && typeof ref === "object" && "number" in ref) {
    const number = (ref as { number?: unknown }).number;
    return typeof number === "number" ? number : null;
  }
  return null;
}

function timelineTieRank(item: WebTimelineSortItem): number {
  if (item.kind === "commit") return 10;
  if (item.kind === "comment") return 20;
  if (item.kind === "line-comment") return 30;
  if (item.kind === "review") return 40;
  if (item.kind === "event" && isTerminalTimelineEvent(item.event?.type)) return 60;
  return 50;
}

function isTerminalTimelineEvent(type: string | undefined): boolean {
  return type === "merge" || type === "merge_pull" || type === "close";
}

function timelineNumericId(item: WebTimelineSortItem): number | null {
  return item.event?.id ?? item.review?.id ?? item.comment?.id ?? null;
}

function timelineStringId(item: WebTimelineSortItem): string {
  if (item.commit) return `${item.kind}:${item.commit.sha}`;
  return item.kind;
}
