// The local Workbench's CollaborationClient (#262/#263): implements the same
// surface the collaboration routes call, but sourced from the connected core's
// typed Cosheaf API (the Origin API) instead of a co-located forge. This is the
// "local" half of the seam — hosted uses the forge client directly.
//
// A workspace with no connected core has no collaboration source; the migrated
// routes render a Connect prompt rather than throwing. `localCollaborationClient`
// returns either an OriginCollaborationClient (connected) or that sentinel.
//
// Shape contract: CollaborationClient is the exact method surface the routes
// call, so every method here must return the SAME object shape the hosted forge
// client returns. Those shapes are derived structurally from CollaborationClient
// (the `*Shape` aliases below) — this file is forge-name-free by the Workbench
// boundary rule (the no-forge-in-workbench lint), so the seam's forge reference
// lives only in server/collaboration-client.ts, never here. The core's typed
// Cosheaf API returns narrower Cosheaf DTOs (IssueRow/IssueDetail/…); we map
// those back up to the shapes the routes consume. The mapping is lossy for shape
// fields the typed API does not expose (issue `id`, full author `user`
// avatar/email, label `scope`), but the issue routes only read the subset that
// survives — see the #263 report.

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
import type { PrCommit, PrFile, PrMeta, ReviewState, ReviewSubmitEvent } from "../../shared/review.js";
import type { Role } from "../../shared/roles.js";
import type { CollaborationClient } from "../collaboration-client.js";
import {
  activityRowToShape,
  type ActivityShape,
  type BranchJson,
  branchToShape,
  type BranchProtectionShape,
  type BranchShape,
  type CollaboratorShape,
  collaboratorToShape,
  type CommentShape,
  commentToShape,
  dependencyRowToShape,
  issueDetailToShape,
  issueRowToShape,
  type IssueShape,
  iso,
  type LabelShape,
  lineCommentToShape,
  type MilestoneShape,
  milestoneToShape,
  type NotificationThreadShape,
  notificationRowToShape,
  type PinnedRow,
  pinnedRowToShape,
  prCommitToShape,
  prFileToShape,
  prMetaToPullShape,
  type PullCommentShape,
  type PullCommitShape,
  type PullFileShape,
  type PullShape,
  type RepoShape,
  type ReviewDto,
  reviewDtoToShape,
  type ReviewerShape,
  type ReviewShape,
  type TimelineShape,
  timelineToShape,
  toLabelShape,
  writtenIssueToShape,
} from "./origin-shapes.js";
import { parseOriginResponse, RemoteCosheafError } from "./remote-cosheaf-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

// True when no core is connected for this workspace; the migrated collaboration
// routes branch on this to show the Connect form instead of data.
export class NoCoreConnectedError extends Error {
  constructor() {
    super("No Cosheaf server connected for this workspace.");
    this.name = "NoCoreConnectedError";
  }
}

// Throws NoCoreConnectedError for every method so the type is satisfied and any
// accidental use is loud; routes branch on the absence of a remote before
// calling, so this is never reached at runtime in connected mode.
function unconnectedClient(): CollaborationClient {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new NoCoreConnectedError();
        };
      },
    },
  ) as CollaborationClient;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type IssueListOpts = {
  state?: "open" | "closed" | "all";
  page?: number;
  limit?: number;
  assigned_by?: string;
  created_by?: string;
  mentioned_by?: string;
  labels?: string;
  milestones?: string;
  sort?: string;
  q?: string;
};

// The connected-core collaboration source. Bound to {baseUrl, token}; every read
// hits the core's typed Cosheaf API with `Authorization: Bearer <token>` and
// never a forge path. Only the issue-read surface (#263) is implemented; the
// remaining CollaborationClient methods are supplied as throwing stubs by
// `withUnimplementedStubs` until their owning agents land them.
export class OriginCollaborationClient {
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(
    baseUrl: string,
    private readonly token: string,
    opts: { fetch?: FetchLike } = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
  }

  private repoPath(owner: string, repo: string, suffix: string): string {
    return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  // One transport for every verb: bearer auth, optional query, JSON body +
  // content-type only when a body is present, status-bearing RemoteCosheafError
  // on non-2xx, and the `text ? JSON.parse : undefined` tail. Never a forge path.
  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return parseOriginResponse<T>(res);
  }

  private get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  // For resources the forge client returns as `T | null` on a 404 (getPull,
  // getRepo): swallow the status-bearing 404 into null, re-throw anything else.
  private async getOrNull<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (err) {
      if (err instanceof RemoteCosheafError && err.status === 404) return null;
      throw err;
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private send<T>(
    method: "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    return this.request<T>(method, path, opts);
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("PUT", path, { body });
  }
  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("PATCH", path, { body });
  }
  private del<T>(path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    return this.send<T>("DELETE", path, opts);
  }

  async listIssues(owner: string, repo: string, opts: IssueListOpts = {}): Promise<IssueShape[]> {
    const r = await this.get<{ issues: IssueRow[] }>(this.repoPath(owner, repo, "/issues"), {
      state: opts.state,
      q: opts.q,
      labels: opts.labels,
      milestones: opts.milestones,
      assigned_by: opts.assigned_by,
      created_by: opts.created_by,
      mentioned_by: opts.mentioned_by,
      sort: opts.sort,
      page: opts.page,
      limit: opts.limit,
    });
    return (r.issues ?? []).map(issueRowToShape);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<IssueShape> {
    const detail = await this.get<IssueDetail>(this.repoPath(owner, repo, `/issues/${number}`));
    return issueDetailToShape(detail);
  }

  async listIssueComments(owner: string, repo: string, number: number): Promise<CommentShape[]> {
    const r = await this.get<{ comments: IssueComment[] }>(this.repoPath(owner, repo, `/issues/${number}/comments`));
    return (r.comments ?? []).map(commentToShape);
  }

  async listIssueTimeline(owner: string, repo: string, number: number): Promise<TimelineShape[]> {
    const r = await this.get<{ events: TimelineEvent[] }>(this.repoPath(owner, repo, `/issues/${number}/timeline`));
    return (r.events ?? []).map(timelineToShape);
  }

  async listLabels(owner: string, repo: string): Promise<LabelShape[]> {
    const r = await this.get<{ labels: Label[] }>(this.repoPath(owner, repo, "/labels"));
    return (r.labels ?? []).map(toLabelShape);
  }

  async listMilestones(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<MilestoneShape[]> {
    const r = await this.get<{ milestones: Milestone[] }>(this.repoPath(owner, repo, "/milestones"), { state });
    return (r.milestones ?? []).map(milestoneToShape);
  }

  async listPinnedIssues(owner: string, repo: string): Promise<IssueShape[]> {
    const r = await this.get<{ issues: PinnedRow[] }>(this.repoPath(owner, repo, "/issues/pinned"));
    return (r.issues ?? []).map(pinnedRowToShape);
  }

  async listIssueDependencies(owner: string, repo: string, number: number): Promise<IssueShape[]> {
    const r = await this.get<{ issues: DependencyRow[] }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`));
    return (r.issues ?? []).map(dependencyRowToShape);
  }

  async listIssueBlocks(owner: string, repo: string, number: number): Promise<IssueShape[]> {
    const r = await this.get<{ issues: DependencyRow[] }>(this.repoPath(owner, repo, `/issues/${number}/blocks`));
    return (r.issues ?? []).map(dependencyRowToShape);
  }

  // ---- issue writes ----

  // The typed create route returns only {number,title,state}; the issue routes
  // read just those off the result. `assignees` has no typed create endpoint and
  // is dropped (no route passes it on create).
  async createIssue(
    owner: string,
    repo: string,
    opts: { title: string; body: string; assignees?: string[]; labels?: number[] },
  ): Promise<IssueShape> {
    const r = await this.post<{ number: number; title: string; state: "open" | "closed" }>(
      this.repoPath(owner, repo, "/issues"),
      { title: opts.title, body: opts.body, ...(opts.labels?.length ? { labels: opts.labels } : {}) },
    );
    return writtenIssueToShape(r);
  }

  // The forge editIssue is one method; the typed API splits it into three routes
  // (title/body, state, milestone). Dispatch by which fields the patch carries —
  // the routes only ever send one group, but combined title/body+milestone (the
  // web edit form) is handled by running both. `assignees` has no typed endpoint
  // and is dropped. A null/0 milestone clears it (the typed route reads id=null
  // as clear).
  async editIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number; assignees?: string[] },
  ): Promise<IssueShape> {
    let shape: IssueShape | undefined;
    if (patch.title !== undefined || patch.body !== undefined) {
      const tb: { title?: string; body?: string } = {};
      if (patch.title !== undefined) tb.title = patch.title;
      if (patch.body !== undefined) tb.body = patch.body;
      shape = writtenIssueToShape(
        await this.patch<{ number: number; title: string; body: string; state: "open" | "closed" }>(
          this.repoPath(owner, repo, `/issues/${number}`),
          tb,
        ),
      );
    }
    if (patch.state !== undefined) {
      const r = await this.patch<{ state: "open" | "closed" }>(
        this.repoPath(owner, repo, `/issues/${number}/state`),
        { state: patch.state },
      );
      shape = writtenIssueToShape({ number, title: shape?.title ?? "", state: r.state });
    }
    if (patch.milestone !== undefined) {
      await this.patch(this.repoPath(owner, repo, `/issues/${number}/milestone`), {
        id: patch.milestone === 0 ? null : patch.milestone,
      });
    }
    return shape ?? writtenIssueToShape({ number, title: "", state: "open" });
  }

  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<CommentShape> {
    const r = await this.post<IssueComment>(this.repoPath(owner, repo, `/issues/${number}/comments`), { body });
    return commentToShape(r);
  }

  // The forge addresses a comment by id without an issue number; the core's
  // number-less typed routes (issues/comments/:id) match that, so these only
  // need the comment id. The PATCH route returns the updated IssueComment DTO.
  async editIssueComment(owner: string, repo: string, id: number, body: string): Promise<CommentShape> {
    const r = await this.patch<IssueComment>(this.repoPath(owner, repo, `/issues/comments/${id}`), { body });
    return commentToShape(r);
  }

  async deleteIssueComment(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/issues/comments/${id}`));
  }

  // Returns the issue's labels after the set; the typed route wraps them as
  // {labels}. Other call sites ignore the return.
  async setIssueLabels(owner: string, repo: string, number: number, labels: number[]): Promise<LabelShape[]> {
    const r = await this.put<{ labels: Label[] }>(this.repoPath(owner, repo, `/issues/${number}/labels`), { labels });
    return (r.labels ?? []).map(toLabelShape);
  }

  async pinIssue(owner: string, repo: string, number: number): Promise<void> {
    await this.post(this.repoPath(owner, repo, `/issues/${number}/pin`), {});
  }

  async unpinIssue(owner: string, repo: string, number: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/issues/${number}/pin`));
  }

  async createLabel(
    owner: string,
    repo: string,
    opts: { name: string; color: string; description?: string; exclusive?: boolean; is_archived?: boolean },
  ): Promise<LabelShape> {
    const r = await this.post<Label>(this.repoPath(owner, repo, "/labels"), {
      name: opts.name,
      color: opts.color,
      description: opts.description,
      exclusive: opts.exclusive,
    });
    return toLabelShape(r);
  }

  async editLabel(
    owner: string,
    repo: string,
    id: number,
    patch: { name?: string; color?: string; description?: string; exclusive?: boolean; is_archived?: boolean },
  ): Promise<LabelShape> {
    const r = await this.patch<Label>(this.repoPath(owner, repo, `/labels/${id}`), patch);
    return toLabelShape(r);
  }

  async deleteLabel(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/labels/${id}`));
  }

  async createMilestone(owner: string, repo: string, opts: { title: string; description?: string }): Promise<MilestoneShape> {
    const r = await this.post<Milestone>(this.repoPath(owner, repo, "/milestones"), opts);
    return milestoneToShape(r);
  }

  async editMilestone(
    owner: string,
    repo: string,
    id: number,
    patch: { title?: string; description?: string; state?: "open" | "closed" },
  ): Promise<MilestoneShape> {
    const r = await this.patch<Milestone>(this.repoPath(owner, repo, `/milestones/${id}`), patch);
    return milestoneToShape(r);
  }

  async deleteMilestone(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/milestones/${id}`));
  }

  // The typed dependency routes take the dependency issue number in the body and
  // return the updated issue as a compact {issue} dependency row.
  async addIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<IssueShape> {
    const r = await this.post<{ issue: DependencyRow }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`), {
      index: dependencyIndex,
    });
    return dependencyRowToShape(r.issue);
  }

  async removeIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<IssueShape> {
    const r = await this.del<{ issue: DependencyRow }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`), {
      body: { index: dependencyIndex },
    });
    return dependencyRowToShape(r.issue);
  }

  // Remove a "blocks" edge (this issue blocks `blockIndex`). The forge's
  // removeIssueBlock returns void; the typed DELETE /blocks route mirrors the
  // dependency convention (issue number in the body) and the callers ignore the
  // return, so nothing is mapped back.
  async removeIssueBlock(owner: string, repo: string, number: number, blockIndex: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/issues/${number}/blocks`), { body: { index: blockIndex } });
  }

  // ---- pulls / reviews ----

  async listPulls(
    owner: string,
    repo: string,
    opts:
      | { state?: "open" | "closed" | "all"; labels?: number[]; milestone?: number; poster?: string; sort?: string }
      | "open"
      | "closed"
      | "all" = {},
  ): Promise<PullShape[]> {
    const o = typeof opts === "string" ? { state: opts } : opts;
    const r = await this.get<{ pulls: PrMeta[] }>(this.repoPath(owner, repo, "/pulls"), {
      state: o.state,
      sort: "sort" in o ? o.sort : undefined,
      milestone: "milestone" in o ? o.milestone : undefined,
      // The typed /pulls route reads the poster filter from the `author` query.
      author: "poster" in o ? o.poster : undefined,
      labels: "labels" in o ? o.labels?.join(",") : undefined,
    });
    return (r.pulls ?? []).map(prMetaToPullShape);
  }

  async getPull(owner: string, repo: string, index: number): Promise<PullShape | null> {
    const r = await this.getOrNull<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}`));
    return r ? prMetaToPullShape(r.pull) : null;
  }

  // The typed /pulls/:n/files response carries each file's per-file patch slice
  // (each starting at a `diff --git` header), so concatenating them reproduces a
  // unified diff the route's split-by-file parser re-splits correctly.
  async getPullDiff(owner: string, repo: string, index: number): Promise<string> {
    const r = await this.get<{ files: PrFile[] }>(this.repoPath(owner, repo, `/pulls/${index}/files`));
    return (r.files ?? [])
      .map((f) => f.patch)
      .filter((patch) => patch.length > 0)
      .join("\n");
  }

  async listPullFiles(owner: string, repo: string, index: number): Promise<PullFileShape[]> {
    const r = await this.get<{ files: PrFile[] }>(this.repoPath(owner, repo, `/pulls/${index}/files`));
    return (r.files ?? []).map(prFileToShape);
  }

  async listPullCommits(owner: string, repo: string, index: number): Promise<PullCommitShape[]> {
    const r = await this.get<{ commits: PrCommit[] }>(this.repoPath(owner, repo, `/pulls/${index}/commits`));
    return (r.commits ?? []).map(prCommitToShape);
  }

  async listPullComments(owner: string, repo: string, index: number): Promise<PullCommentShape[]> {
    const r = await this.get<{ comments: LineComment[] }>(this.repoPath(owner, repo, `/pulls/${index}/comments`));
    return (r.comments ?? []).map(lineCommentToShape);
  }

  async listReviews(owner: string, repo: string, index: number): Promise<ReviewShape[]> {
    const r = await this.get<{ reviews: ReviewDto[] }>(this.repoPath(owner, repo, `/pulls/${index}/reviews`));
    return (r.reviews ?? []).map(reviewDtoToShape);
  }

  // ---- pull / review writes ----

  // The typed create route returns the PR metadata directly; it also de-dupes an
  // existing head→base PR to 200. On a genuine empty-diff/validation reject it
  // 409s, which surfaces here as a status-bearing error.
  async createPull(
    owner: string,
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<PullShape> {
    const r = await this.post<PrMeta>(this.repoPath(owner, repo, "/pulls"), opts);
    return prMetaToPullShape(r);
  }

  // The forge editPull is one method; the typed API splits it (title/body PATCH,
  // labels PUT, state via close/reopen). Milestone has no typed pull endpoint and
  // is dropped. Title/body and labels return the updated PR; a state-only change
  // re-reads it (callers of the state-only path ignore the return).
  async editPull(
    owner: string,
    repo: string,
    index: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: number[]; milestone?: number },
  ): Promise<PullShape> {
    let pull: PullShape | undefined;
    if (patch.title !== undefined || patch.body !== undefined) {
      const tb: { title?: string; body?: string } = {};
      if (patch.title !== undefined) tb.title = patch.title;
      if (patch.body !== undefined) tb.body = patch.body;
      const r = await this.patch<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}`), tb);
      pull = prMetaToPullShape(r.pull);
    }
    if (patch.labels !== undefined) {
      const r = await this.put<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}/labels`), { labels: patch.labels });
      pull = prMetaToPullShape(r.pull);
    }
    if (patch.state !== undefined) {
      await this.post(this.repoPath(owner, repo, `/pulls/${index}/${patch.state === "closed" ? "close" : "reopen"}`), {});
    }
    if (pull) return pull;
    const fetched = await this.getPull(owner, repo, index);
    if (!fetched) throw new RemoteCosheafError(404, `remote cosheaf 404: pull ${index} not found`);
    return fetched;
  }

  async mergePull(
    owner: string,
    repo: string,
    index: number,
    opts: { Do: "merge" | "squash" | "rebase"; message?: string; force?: boolean },
  ): Promise<void> {
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/merge`), { Do: opts.Do, force: opts.force ?? false });
  }

  // The typed verdict route accepts only a simple {event,body} and returns
  // counts, not the review object; PENDING maps to the find-or-create route
  // (which returns the new review id, the one field findOrCreatePendingReview
  // reads). The standalone single-comment path arrives with already-resolved
  // diff positions, which the verdict route has no form for — so it maps onto
  // the same pending-review → add-comment(s) → submit sequence the
  // addCommentToReview path uses. The synthesized review carries the fields
  // callers read.
  async createReview(
    owner: string,
    repo: string,
    index: number,
    opts: {
      event: ReviewState;
      body: string;
      comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }>;
      commit_id?: string;
    },
  ): Promise<ReviewShape> {
    if (opts.comments && opts.comments.length > 0) {
      // Open (or reuse) a pending review, attach each already-resolved position
      // comment, then submit it as the verdict. The standalone comment path
      // always sends event=COMMENT, but approve/request_changes-with-comments
      // map the same way.
      const created = await this.post<{ review_id: number }>(
        this.repoPath(owner, repo, `/pulls/${index}/pending-review`),
        {},
      );
      const reviewId = created.review_id;
      for (const cm of opts.comments) {
        await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/review-comments`), {
          path: cm.path,
          body: cm.body,
          ...(cm.new_position !== undefined ? { new_position: cm.new_position } : {}),
          ...(cm.old_position !== undefined ? { old_position: cm.old_position } : {}),
        });
      }
      const verdict =
        opts.event === "APPROVED" ? "approve" : opts.event === "REQUEST_CHANGES" ? "request_changes" : "comment";
      await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/submit`), {
        event: verdict,
        body: opts.body,
      });
      return { id: reviewId, body: opts.body, state: opts.event, user: null, submitted_at: iso(0) };
    }
    if (opts.event === "PENDING") {
      const r = await this.post<{ review_id: number }>(this.repoPath(owner, repo, `/pulls/${index}/pending-review`), {});
      return { id: r.review_id, body: opts.body, state: "PENDING", user: null, submitted_at: iso(0) };
    }
    const event = opts.event === "APPROVED" ? "APPROVE" : opts.event;
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/reviews`), { event, body: opts.body });
    return { id: 0, body: opts.body, state: opts.event, user: null, submitted_at: iso(0) };
  }

  // Submit a previously-created pending review; the typed route takes a
  // lowercase verdict and returns {ok}. Callers ignore the return.
  async submitPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts: { event: ReviewSubmitEvent; body: string },
  ): Promise<ReviewShape> {
    const event = opts.event === "APPROVED" ? "approve" : opts.event === "REQUEST_CHANGES" ? "request_changes" : "comment";
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/submit`), {
      event,
      body: opts.body,
    });
    return { id: reviewId, body: opts.body, state: opts.event, user: null, submitted_at: iso(0) };
  }

  // Add an inline comment to an existing pending review. The shared route already
  // resolved the diff anchor to forge positions (new_position/old_position), so
  // this forwards those to the typed pending-review review-comments route, which
  // maps them straight onto the core's addCommentToReview. The forge returns the
  // created comment, but every caller ignores it, so a minimal shape is synthesized
  // from the inputs (position fields mirror lineCommentToShape's anchor mapping).
  async addCommentToReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts: { path: string; body: string; new_position?: number; old_position?: number },
  ): Promise<PullCommentShape> {
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/review-comments`), {
      path: opts.path,
      body: opts.body,
      ...(opts.new_position !== undefined ? { new_position: opts.new_position } : {}),
      ...(opts.old_position !== undefined ? { old_position: opts.old_position } : {}),
    });
    return {
      id: 0,
      pull_request_review_id: reviewId,
      path: opts.path,
      body: opts.body,
      position: opts.new_position ?? null,
      original_position: opts.old_position ?? null,
      commit_id: "",
      original_commit_id: "",
      diff_hunk: "",
      user: null,
      created_at: iso(0),
      updated_at: iso(0),
    };
  }

  async deleteReviewComment(owner: string, repo: string, index: number, reviewId: number, commentId: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/pulls/${index}/comments/${commentId}`), { query: { review_id: reviewId } });
  }

  async createPullReviewRequests(owner: string, repo: string, index: number, reviewers: string[]): Promise<void> {
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/review-requests`), { reviewers });
  }

  async deletePullReviewRequests(owner: string, repo: string, index: number, reviewers: string[]): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/pulls/${index}/review-requests`), { body: { reviewers } });
  }

  // ---- repo / settings reads ----

  async listBranches(owner: string, repo: string): Promise<BranchShape[]> {
    const r = await this.get<BranchJson[]>(this.repoPath(owner, repo, "/branches"));
    return (r ?? []).map(branchToShape);
  }

  async listCollaborators(owner: string, repo: string): Promise<CollaboratorShape[]> {
    const r = await this.get<{ collaborators: Array<{ login: string; permission: string }> }>(
      this.repoPath(owner, repo, "/collaborators"),
    );
    return (r.collaborators ?? []).map(collaboratorToShape);
  }

  // Available reviewers for a PR = the repo's collaborators (the forge's
  // repo-scoped reviewer list). The core has no separate reviewer-candidates
  // endpoint, so source it from /collaborators and map to the user shape the
  // PR page's reviewer picker reads (login only).
  async listPullReviewers(owner: string, repo: string): Promise<ReviewerShape[]> {
    const r = await this.get<{ collaborators: Array<{ login: string; permission: string }> }>(
      this.repoPath(owner, repo, "/collaborators"),
    );
    return (r.collaborators ?? []).map((m) => ({ id: 0, login: m.login }) as ReviewerShape);
  }

  async listRepoTopics(owner: string, repo: string): Promise<string[]> {
    const r = await this.get<{ topics: string[] }>(this.repoPath(owner, repo, "/topics"));
    return r.topics ?? [];
  }

  // Replace the full topic set. The core's PUT /topics route forwards to the
  // forge (which replaces, not merges); the caller composes the merged list.
  async replaceRepoTopics(owner: string, repo: string, topics: string[]): Promise<void> {
    await this.put(this.repoPath(owner, repo, "/topics"), { topics });
  }

  // The core's DELETE /members/:username route removes the collaborator on the
  // forge (idempotent: a missing member is a 404/422 the route swallows).
  async removeCollaborator(owner: string, repo: string, username: string): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/members/${encodeURIComponent(username)}`));
  }

  // Add or update a collaborator's role. Not part of the CollaborationClient
  // surface, so it is called directly off the instance via `localMemberSetter`.
  // The core's PUT /members/:username route runs the full member-set
  // (collaborator + branch-protection push-whitelist) server-side, matching the
  // hosted add path.
  async setMember(owner: string, repo: string, username: string, role: Role): Promise<void> {
    await this.put(this.repoPath(owner, repo, `/members/${encodeURIComponent(username)}`), { role });
  }

  async getRepo(owner: string, repo: string): Promise<RepoShape | null> {
    // The typed repo route returns a forge-repo-compatible object (description,
    // visibility, default branch, owner, topics-when-present).
    return this.getOrNull<RepoShape>(this.repoPath(owner, repo, ""));
  }

  // Patch repo metadata. The settings meta form sends description, visibility
  // (mapped to `private`), and default_branch; only the set fields are forwarded.
  // The typed PATCH route returns the same forge-repo-compatible object getRepo
  // does, so it maps straight to RepoShape.
  async editRepo(
    owner: string,
    repo: string,
    patch: { description?: string; private?: boolean; default_branch?: string },
  ): Promise<RepoShape> {
    const body: Record<string, unknown> = {};
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.private !== undefined) body.private = patch.private;
    if (patch.default_branch !== undefined) body.default_branch = patch.default_branch;
    return this.patch<RepoShape>(this.repoPath(owner, repo, ""), body);
  }

  // Delete the repo. Idempotent: a 404 means the repo is already gone, which the
  // hosted settings-delete path also swallows.
  async deleteRepo(owner: string, repo: string): Promise<void> {
    try {
      await this.del(this.repoPath(owner, repo, ""));
    } catch (err) {
      if (err instanceof RemoteCosheafError && err.status === 404) return;
      throw err;
    }
  }

  // The typed surface exposes only the main-branch review policy via /settings;
  // every caller reads this for "main", and `min_approvals` is that branch's
  // required-approvals count.
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionShape | null> {
    const r = await this.get<{ min_approvals: number }>(this.repoPath(owner, repo, "/settings"));
    return { branch_name: branch, required_approvals: r.min_approvals };
  }

  // The typed surface exposes the main-branch review policy only as
  // PUT /settings {min_approvals}; both create and update map onto it (every
  // caller targets "main"). Push-whitelist and non-main branches aren't
  // expressible and aren't used by the migrated settings routes.
  async createBranchProtection(
    owner: string,
    repo: string,
    opts: { branch_name: string; required_approvals?: number; push_whitelist_usernames?: string[] },
  ): Promise<BranchProtectionShape> {
    const r = await this.put<{ min_approvals: number }>(this.repoPath(owner, repo, "/settings"), {
      min_approvals: opts.required_approvals ?? 1,
    });
    return { branch_name: opts.branch_name, required_approvals: r.min_approvals };
  }

  async updateBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    patch: { required_approvals?: number },
  ): Promise<BranchProtectionShape> {
    const r = await this.put<{ min_approvals: number }>(this.repoPath(owner, repo, "/settings"), {
      min_approvals: patch.required_approvals,
    });
    return { branch_name: branch, required_approvals: r.min_approvals };
  }

  async renderMarkdown(owner: string, repo: string, text: string): Promise<string> {
    const r = await this.post<{ html: string }>(this.repoPath(owner, repo, "/markdown/render"), { text });
    return r.html ?? "";
  }

  // ---- notifications ----

  // The typed feed is already filtered to unread Issue/Pull threads, so the
  // forge-style status/subject opts are accepted for signature parity and
  // ignored here.
  async listRepoNotifications(
    owner: string,
    repo: string,
    _opts: { statusTypes?: readonly string[]; subjectTypes?: readonly string[] } = {},
  ): Promise<NotificationThreadShape[]> {
    const r = await this.get<{ notifications: NotificationRow[] }>(this.repoPath(owner, repo, "/notifications"));
    return (r.notifications ?? []).map(notificationRowToShape);
  }

  async listRepoActivities(owner: string, repo: string, opts: { limit?: number } = {}): Promise<ActivityShape[]> {
    const r = await this.get<{ activities: ActivityRow[] }>(this.repoPath(owner, repo, "/activities"), {
      limit: opts.limit,
    });
    return (r.activities ?? []).map(activityRowToShape);
  }

  // ---- notification writes ----

  // Resolve a single notification thread by its global forge id. The core's
  // typed global route maps the forge thread to a NotificationRow (Issue/Pull
  // only); rebuild the thread shape the notification route reads — it checks
  // `repository.full_name` to scope the thread to this workspace before marking
  // it read. A non-issue/pull or unreadable thread 404s, which the route's
  // `.catch(() => null)` degrades to a not-found rather than a 500.
  async getNotificationThread(id: number): Promise<NotificationThreadShape> {
    const r = await this.get<{ notification: NotificationRow }>(`/api/v1/notifications/threads/${id}`);
    return notificationRowToShape(r.notification);
  }

  // Mark one thread read by its global forge id (the core's typed global route
  // forwards to the forge's per-thread mark-read). The thread id is global, so
  // no owner/repo is needed here — the calling route already did the per-repo
  // ownership check via getNotificationThread.
  async markNotificationRead(id: number): Promise<void> {
    await this.post(`/api/v1/notifications/${id}/read`, {});
  }

  // Mark every unread thread in this repo read (the core's typed repo route
  // forwards to the forge's repo-scoped bulk mark-read).
  async markRepoNotificationsRead(owner: string, repo: string): Promise<void> {
    await this.post(this.repoPath(owner, repo, "/notifications/read-all"), {});
  }
}

// Wrap a read-capable origin client so any not-yet-implemented
// CollaborationClient method throws clearly instead of being `undefined`. The
// issue/pull/review/notification/repo + settings surfaces are all backed by
// typed core endpoints now; the notification mutation surface
// (`getNotificationThread`/`markNotificationRead`/`markRepoNotificationsRead`)
// and `createReview` with inline comments are the latest to land. Implemented
// methods delegate (bound to the real instance so their internal `this.get`
// works); anything else is a loud stub. Still stubbed deliberately:
// `getRepoPermission` has no typed core endpoint — its only `ctx.collab` caller
// (the PR reviewer-permission column) is `.catch(() => null)`-degraded, so the
// async-rejecting stub returns null rather than 500ing. The cast is the "cast
// unimplemented methods" the seam allows.
function withUnimplementedStubs(client: OriginCollaborationClient): CollaborationClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      // Reject ASYNCHRONOUSLY, not a synchronous throw: every CollaborationClient
      // method is async, and call sites wrap optional ones in `.catch(() => [])`
      // (e.g. listPullReviewers on the PR page). A sync throw fires before the
      // promise exists, so `.catch` never attaches and the page 500s; a rejected
      // promise lets those guards degrade gracefully.
      return () =>
        Promise.reject(new Error(`OriginCollaborationClient.${String(prop)} is not implemented yet`));
    },
  }) as unknown as CollaborationClient;
}

// The collaboration source for a local workspace: the connected core via the
// Origin API, or the unconnected sentinel.
export function localCollaborationClient(entry: WorkspaceEntry): CollaborationClient {
  if (entry.remote) {
    return withUnimplementedStubs(new OriginCollaborationClient(entry.remote.url, entry.remote.token));
  }
  return unconnectedClient();
}

// Add/update-collaborator capability for the local settings page. `setMember`
// isn't on the CollaborationClient surface, so the web context binds this
// closure: connected → proxy to the core members route; unconnected → throw the
// Connect sentinel.
export function localMemberSetter(
  entry: WorkspaceEntry,
  owner: string,
  repo: string,
): (username: string, role: Role) => Promise<void> {
  if (entry.remote) {
    const client = new OriginCollaborationClient(entry.remote.url, entry.remote.token);
    return (username, role) => client.setMember(owner, repo, username, role);
  }
  return () => {
    throw new NoCoreConnectedError();
  };
}
