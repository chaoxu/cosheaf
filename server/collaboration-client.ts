// The collaboration seam (#262): the single client every collaboration route
// reads instead of the raw Forgejo client. One interface, two implementations —
// the co-located forge (hosted) and the bound remote core via the Origin API
// (local Workbench). This is the keystone that lets ONE router + ONE route set
// serve both modes; local vs hosted becomes an injected trigger, not a fork.
//
// `CollaborationClient` is the exact method surface the collaboration routes
// call. Hosted injects an in-process Core adapter over Forgejo; local injects an
// Origin HTTP client. The contract is route-owned: shared DTO surfaces stay
// shared across transports, while the few remaining forge-shaped compatibility
// methods are explicit in this type.
//
// Content (getRawFile/getTree/listBranches/file writes) stays on
// `WorkspaceBackend`, not here — that is the other trigger (local git vs forge).

import type { BranchRow } from "../shared/branches.js";
import type { DependencyRow, IssueComment, IssueDetail, IssueRow, Label, Milestone, NotificationRow, TimelineEvent } from "../shared/issues.js";
import type { LineComment } from "../shared/comments.js";
import type { PrCommit, PrFile, PrMeta, ReviewDto, ReviewState, ReviewSubmitEvent } from "../shared/review.js";
import type { Forgejo, NotificationListOpts } from "./forgejo.js";

// The exact methods the collaboration routes/pages need from the forge/core,
// grouped to mirror the surfaces (issues / pulls+reviews / notifications +
// activity / repo + settings).
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
  | "searchUsers"
>;

export type CollaborationClient = Omit<
  ForgejoCollaborationClient,
  | "listIssues"
  | "getIssue"
  | "createIssue"
  | "editIssue"
  | "listIssueComments"
  | "createIssueComment"
  | "editIssueComment"
  | "listIssueTimeline"
  | "listLabels"
  | "createLabel"
  | "editLabel"
  | "setIssueLabels"
  | "listMilestones"
  | "createMilestone"
  | "editMilestone"
  | "listPinnedIssues"
  | "listIssueDependencies"
  | "addIssueDependency"
  | "removeIssueDependency"
  | "listIssueBlocks"
  | "listPulls"
  | "getPull"
  | "createPull"
  | "editPull"
  | "listPullFiles"
  | "listPullCommits"
  | "listPullComments"
  | "listReviews"
  | "createReview"
  | "submitPullReview"
  | "addCommentToReview"
  | "listRepoNotifications"
  | "getNotificationThread"
  | "listBranches"
  | "searchUsers"
> & {
  listIssues(owner: string, repo: string, opts?: Parameters<Forgejo["listIssues"]>[2]): Promise<IssueRow[]>;
  getIssue(owner: string, repo: string, number: number): Promise<IssueDetail>;
  createIssue(owner: string, repo: string, opts: Parameters<Forgejo["createIssue"]>[2]): Promise<IssueDetail>;
  editIssue(owner: string, repo: string, number: number, patch: Parameters<Forgejo["editIssue"]>[3]): Promise<IssueDetail>;
  listIssueComments(owner: string, repo: string, number: number): Promise<IssueComment[]>;
  createIssueComment(owner: string, repo: string, number: number, body: string): Promise<IssueComment>;
  editIssueComment(owner: string, repo: string, id: number, body: string): Promise<IssueComment>;
  listIssueTimeline(owner: string, repo: string, number: number): Promise<TimelineEvent[]>;
  listLabels(owner: string, repo: string): Promise<Label[]>;
  createLabel(owner: string, repo: string, opts: Parameters<Forgejo["createLabel"]>[2]): Promise<Label>;
  editLabel(owner: string, repo: string, id: number, patch: Parameters<Forgejo["editLabel"]>[3]): Promise<Label>;
  setIssueLabels(owner: string, repo: string, number: number, labels: number[]): Promise<Label[]>;
  listMilestones(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<Milestone[]>;
  createMilestone(owner: string, repo: string, opts: Parameters<Forgejo["createMilestone"]>[2]): Promise<Milestone>;
  editMilestone(owner: string, repo: string, id: number, patch: Parameters<Forgejo["editMilestone"]>[3]): Promise<Milestone>;
  listPinnedIssues(owner: string, repo: string): Promise<IssueRow[]>;
  listIssueDependencies(owner: string, repo: string, number: number): Promise<DependencyRow[]>;
  addIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<DependencyRow>;
  removeIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<DependencyRow>;
  listIssueBlocks(owner: string, repo: string, number: number): Promise<DependencyRow[]>;
  listPulls(owner: string, repo: string, opts?: Parameters<Forgejo["listPulls"]>[2]): Promise<PrMeta[]>;
  getPull(owner: string, repo: string, number: number): Promise<PrMeta | null>;
  createPull(owner: string, repo: string, opts: Parameters<Forgejo["createPull"]>[2]): Promise<PrMeta>;
  editPull(owner: string, repo: string, number: number, patch: Parameters<Forgejo["editPull"]>[3]): Promise<PrMeta>;
  listPullFiles(owner: string, repo: string, number: number): Promise<PrFile[]>;
  listPullCommits(owner: string, repo: string, number: number): Promise<PrCommit[]>;
  listPullComments(owner: string, repo: string, number: number): Promise<LineComment[]>;
  listReviews(owner: string, repo: string, number: number): Promise<ReviewDto[]>;
  createReview(
    owner: string,
    repo: string,
    number: number,
    opts: {
      event: ReviewState;
      body: string;
      comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
      commit_id?: string;
    },
  ): Promise<ReviewDto>;
  submitPullReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
    opts: { event: ReviewSubmitEvent; body: string },
  ): Promise<ReviewDto>;
  addCommentToReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
    opts: { path: string; body: string; new_position?: number; old_position?: number },
  ): Promise<LineComment>;
  listRepoNotifications(owner: string, repo: string, opts?: NotificationListOpts): Promise<NotificationRow[]>;
  getNotificationThread(id: number): Promise<NotificationRow | null>;
  listBranches(owner: string, repo: string): Promise<BranchRow[]>;
  searchUsers(query: string, limit?: number): Promise<Array<{ login: string }>>;
};
