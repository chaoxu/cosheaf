// The collaboration seam (#262): the single client every collaboration route
// reads instead of the raw Forgejo client. One interface, two implementations —
// the co-located forge (hosted) and the bound remote core via the Origin API
// (local Workbench). This is the keystone that lets ONE router + ONE route set
// serve both modes; local vs hosted becomes an injected trigger, not a fork.
//
// `CollaborationClient` is the exact method surface the collaboration routes
// call. Hosted injects an in-process Core adapter over Forgejo; local injects an
// Origin HTTP client. Surfaces migrate from forge shapes to DTOs one at a time
// here, so both transports expose the same route-owned contract.
//
// Content (getRawFile/getTree/listBranches/file writes) stays on
// `WorkspaceBackend`, not here — that is the other trigger (local git vs forge).

import type { NotificationRow } from "../shared/issues.js";
import type { BranchRow } from "../shared/branches.js";
import type { Forgejo, NotificationListOpts } from "./forgejo.js";

// The exact methods the collaboration routes/pages need from the forge/core.
// Keep this list in sync with the routes as the seam migration (#262) proceeds;
// `scripts/check-...` could later assert no `ctx.fj` survives in collaboration
// routes. Grouped to mirror the surfaces (issues / pulls+reviews / notifications
// + activity / repo + settings).
type ForgejoCollaborationClient = Pick<
  Forgejo,
  // issues
  | "listIssues"
  | "getIssue"
  | "createIssue"
  | "editIssue"
  | "listIssueComments"
  | "createIssueComment"
  | "editIssueComment"
  | "deleteIssueComment"
  | "listIssueTimeline"
  | "listLabels"
  | "createLabel"
  | "editLabel"
  | "deleteLabel"
  | "setIssueLabels"
  | "listMilestones"
  | "createMilestone"
  | "editMilestone"
  | "deleteMilestone"
  | "listPinnedIssues"
  | "pinIssue"
  | "unpinIssue"
  | "listIssueDependencies"
  | "addIssueDependency"
  | "removeIssueDependency"
  | "listIssueBlocks"
  | "removeIssueBlock"
  // pulls + reviews
  | "listPulls"
  | "getPull"
  | "createPull"
  | "editPull"
  | "mergePull"
  | "getPullDiff"
  | "listPullFiles"
  | "listPullCommits"
  | "listPullComments"
  | "listReviews"
  | "createReview"
  | "submitPullReview"
  | "addCommentToReview"
  | "deleteReviewComment"
  | "listPullReviewers"
  | "createPullReviewRequests"
  | "deletePullReviewRequests"
  // notifications + activity
  | "listRepoNotifications"
  | "getNotificationThread"
  | "markNotificationRead"
  | "markRepoNotificationsRead"
  | "listRepoActivities"
  // repo + settings
  | "getRepo"
  | "editRepo"
  | "deleteRepo"
  | "getRepoPermission"
  | "listCollaborators"
  | "removeCollaborator"
  | "getBranchProtection"
  | "createBranchProtection"
  | "updateBranchProtection"
  | "listRepoTopics"
  | "replaceRepoTopics"
  | "renderMarkdown"
  | "listBranches"
>;

export type CollaborationClient = Omit<ForgejoCollaborationClient, "listRepoNotifications" | "getNotificationThread" | "listBranches"> & {
  listRepoNotifications(owner: string, repo: string, opts?: NotificationListOpts): Promise<NotificationRow[]>;
  getNotificationThread(id: number): Promise<NotificationRow | null>;
  listBranches(owner: string, repo: string): Promise<BranchRow[]>;
};
