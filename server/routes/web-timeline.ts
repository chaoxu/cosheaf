import type { ForgejoTimelineEvent } from "../forgejo-types.js";
import { escapeHtml } from "./html-escape.js";

export function webTimelineDescriptionHtml(event: ForgejoTimelineEvent): string {
  const description = webTimelineDescriptionText(event);
  return description ? escapeHtml(description) : "";
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
