// The collaboration seam (#262): the single client every collaboration route
// reads instead of the raw Forgejo client. One interface, two implementations —
// the co-located forge (hosted) and the bound remote core via the Origin API
// (local Workbench). This is the keystone that lets ONE router + ONE route set
// serve both modes; local vs hosted becomes an injected trigger, not a fork.
//
// `CollaborationClient` is a structural `Pick<Forgejo, …>` of exactly the methods
// the collaboration routes call. Because it is a subset of the Forgejo client's
// own surface, the hosted path is a literal no-op: `ctx.collab` is just the
// Forgejo client. The local path supplies an `OriginCollaborationClient` that
// implements the same signatures by talking to the core's typed Cosheaf API.
//
// Content (getRawFile/getTree/listBranches/file writes) stays on
// `WorkspaceBackend`, not here — that is the other trigger (local git vs forge).

import type { Forgejo } from "./forgejo.js";

// The exact methods the collaboration routes/pages need from the forge/core.
// Keep this list in sync with the routes as the seam migration (#262) proceeds;
// `scripts/check-...` could later assert no `ctx.fj` survives in collaboration
// routes. Grouped to mirror the surfaces (issues / pulls+reviews / notifications
// + activity / repo + settings).
export type CollaborationClient = Pick<
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
