// The local Workbench's CollaborationClient (#262/#263): implements the same
// surface the collaboration routes call, but sourced from the connected core's
// typed Cosheaf API (the Origin API) instead of a co-located forge. This is the
// "local" half of the seam — hosted uses the forge client directly.
//
// A workspace with no connected core has no collaboration source; web routes
// render a Connect prompt and typed API routes receive a stable not-connected
// error. `localCollaborationClient` returns either an OriginCollaborationClient
// (connected) or that sentinel.
//
// Shape contract: CollaborationClient is the exact method surface the routes
// call. Shared DTO surfaces pass through directly; narrow repo/settings
// compatibility shapes stay isolated here until those contracts are tightened.

import type { LineComment } from "../../shared/comments.js";
import type { BranchRow } from "../../shared/branches.js";
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
import type { PrCommit, PrFile, PrMeta, ReviewDto, ReviewState, ReviewSubmitEvent } from "../../shared/review.js";
import type { Role } from "../../shared/roles.js";
import type { CollaborationClient } from "../collaboration-client.js";
import { parseOriginResponse, RemoteCosheafError } from "./remote-cosheaf-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

type BranchShape = Awaited<ReturnType<CollaborationClient["listBranches"]>>[number];
type CollaboratorShape = Awaited<ReturnType<CollaborationClient["listCollaborators"]>>[number];
type RepoShape = NonNullable<Awaited<ReturnType<CollaborationClient["getRepo"]>>>;
type ReviewerShape = Awaited<ReturnType<CollaborationClient["listPullReviewers"]>>[number];
type BranchProtectionShape = NonNullable<Awaited<ReturnType<CollaborationClient["getBranchProtection"]>>>;

function collaboratorToShape(member: { login: string; permission: string }): CollaboratorShape {
  return { id: 0, login: member.login };
}

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

function reviewStateToDecision(state: ReviewState): ReviewDto["decision"] {
  if (state === "APPROVED") return "approve";
  if (state === "REQUEST_CHANGES") return "request_changes";
  if (state === "PENDING") return "pending";
  return "comment";
}

// The connected-core collaboration source. Bound to {baseUrl, token}; every read
// hits the core's typed Cosheaf API with `Authorization: Bearer <token>` and
// never a forge path. It implements the full CollaborationClient surface, so it
// satisfies the seam directly (the type checker verifies this — there is no
// stub Proxy or cast).
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

  async listIssues(owner: string, repo: string, opts: IssueListOpts = {}): Promise<IssueRow[]> {
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
    return r.issues ?? [];
  }

  async getIssue(owner: string, repo: string, number: number): Promise<IssueDetail> {
    return this.get<IssueDetail>(this.repoPath(owner, repo, `/issues/${number}`));
  }

  async listIssueComments(owner: string, repo: string, number: number): Promise<IssueComment[]> {
    const r = await this.get<{ comments: IssueComment[] }>(this.repoPath(owner, repo, `/issues/${number}/comments`));
    return r.comments ?? [];
  }

  async listIssueTimeline(owner: string, repo: string, number: number): Promise<TimelineEvent[]> {
    const r = await this.get<{ events: TimelineEvent[] }>(this.repoPath(owner, repo, `/issues/${number}/timeline`));
    return r.events ?? [];
  }

  async listLabels(owner: string, repo: string): Promise<Label[]> {
    const r = await this.get<{ labels: Label[] }>(this.repoPath(owner, repo, "/labels"));
    return r.labels ?? [];
  }

  async listMilestones(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<Milestone[]> {
    const r = await this.get<{ milestones: Milestone[] }>(this.repoPath(owner, repo, "/milestones"), { state });
    return r.milestones ?? [];
  }

  async listPinnedIssues(owner: string, repo: string): Promise<IssueRow[]> {
    const r = await this.get<{ issues: IssueRow[] }>(this.repoPath(owner, repo, "/issues/pinned"));
    return r.issues ?? [];
  }

  async listIssueDependencies(owner: string, repo: string, number: number): Promise<DependencyRow[]> {
    const r = await this.get<{ issues: DependencyRow[] }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`));
    return r.issues ?? [];
  }

  async listIssueBlocks(owner: string, repo: string, number: number): Promise<DependencyRow[]> {
    const r = await this.get<{ issues: DependencyRow[] }>(this.repoPath(owner, repo, `/issues/${number}/blocks`));
    return r.issues ?? [];
  }

  // ---- issue writes ----

  // The typed create route returns only {number,title,state}; the issue routes
  // read just those off the result. `assignees` has no typed create endpoint and
  // is dropped (no route passes it on create).
  async createIssue(
    owner: string,
    repo: string,
    opts: { title: string; body: string; assignees?: string[]; labels?: number[] },
  ): Promise<IssueDetail> {
    const r = await this.post<{ number: number; title: string; state: "open" | "closed" }>(
      this.repoPath(owner, repo, "/issues"),
      { title: opts.title, body: opts.body, ...(opts.labels?.length ? { labels: opts.labels } : {}) },
    );
    return {
      number: r.number,
      title: r.title,
      body: opts.body,
      state: r.state,
      author_username: "",
      assignees: [],
      labels: [],
      milestone: null,
      comment_count: 0,
      created_at: 0,
      updated_at: 0,
      closed_at: null,
    };
  }

  // The forge editIssue is one method; the typed API splits milestone/state into
  // separate routes, while title/body/assignees share PATCH /issues/:number.
  async editIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number; assignees?: string[] },
  ): Promise<IssueDetail> {
    let detail: IssueDetail | undefined;
    if (patch.title !== undefined || patch.body !== undefined || patch.assignees !== undefined) {
      const tb: { title?: string; body?: string; assignees?: string[] } = {};
      if (patch.title !== undefined) tb.title = patch.title;
      if (patch.body !== undefined) tb.body = patch.body;
      if (patch.assignees !== undefined) tb.assignees = patch.assignees;
      detail = await this.patch<IssueDetail>(
          this.repoPath(owner, repo, `/issues/${number}`),
          tb,
      );
    }
    if (patch.state !== undefined) {
      const r = await this.patch<{ state: "open" | "closed" }>(
        this.repoPath(owner, repo, `/issues/${number}/state`),
        { state: patch.state },
      );
      detail = { ...(detail ?? await this.getIssue(owner, repo, number)), state: r.state };
    }
    if (patch.milestone !== undefined) {
      await this.patch(this.repoPath(owner, repo, `/issues/${number}/milestone`), {
        id: patch.milestone === 0 ? null : patch.milestone,
      });
    }
    return detail ?? this.getIssue(owner, repo, number);
  }

  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<IssueComment> {
    return this.post<IssueComment>(this.repoPath(owner, repo, `/issues/${number}/comments`), { body });
  }

  // The forge addresses a comment by id without an issue number; the core's
  // number-less typed routes (issues/comments/:id) match that, so these only
  // need the comment id. The PATCH route returns the updated IssueComment DTO.
  async editIssueComment(owner: string, repo: string, id: number, body: string): Promise<IssueComment> {
    return this.patch<IssueComment>(this.repoPath(owner, repo, `/issues/comments/${id}`), { body });
  }

  async deleteIssueComment(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/issues/comments/${id}`));
  }

  // Returns the issue's labels after the set; the typed route wraps them as
  // {labels}. Other call sites ignore the return.
  async setIssueLabels(owner: string, repo: string, number: number, labels: number[]): Promise<Label[]> {
    const r = await this.put<{ labels: Label[] }>(this.repoPath(owner, repo, `/issues/${number}/labels`), { labels });
    return r.labels ?? [];
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
  ): Promise<Label> {
    return this.post<Label>(this.repoPath(owner, repo, "/labels"), {
      name: opts.name,
      color: opts.color,
      description: opts.description,
      exclusive: opts.exclusive,
    });
  }

  async editLabel(
    owner: string,
    repo: string,
    id: number,
    patch: { name?: string; color?: string; description?: string; exclusive?: boolean; is_archived?: boolean },
  ): Promise<Label> {
    return this.patch<Label>(this.repoPath(owner, repo, `/labels/${id}`), patch);
  }

  async deleteLabel(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/labels/${id}`));
  }

  async createMilestone(owner: string, repo: string, opts: { title: string; description?: string }): Promise<Milestone> {
    return this.post<Milestone>(this.repoPath(owner, repo, "/milestones"), opts);
  }

  async editMilestone(
    owner: string,
    repo: string,
    id: number,
    patch: { title?: string; description?: string; state?: "open" | "closed" },
  ): Promise<Milestone> {
    return this.patch<Milestone>(this.repoPath(owner, repo, `/milestones/${id}`), patch);
  }

  async deleteMilestone(owner: string, repo: string, id: number): Promise<void> {
    await this.del(this.repoPath(owner, repo, `/milestones/${id}`));
  }

  // The typed dependency routes take the dependency issue number in the body and
  // return the updated issue as a compact {issue} dependency row.
  async addIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<DependencyRow> {
    const r = await this.post<{ issue: DependencyRow }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`), {
      index: dependencyIndex,
    });
    return r.issue;
  }

  async removeIssueDependency(owner: string, repo: string, number: number, dependencyIndex: number): Promise<DependencyRow> {
    const r = await this.del<{ issue: DependencyRow }>(this.repoPath(owner, repo, `/issues/${number}/dependencies`), {
      body: { index: dependencyIndex },
    });
    return r.issue;
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
  ): Promise<PrMeta[]> {
    const o = typeof opts === "string" ? { state: opts } : opts;
    const r = await this.get<{ pulls: PrMeta[] }>(this.repoPath(owner, repo, "/pulls"), {
      state: o.state,
      sort: "sort" in o ? o.sort : undefined,
      milestone: "milestone" in o ? o.milestone : undefined,
      // The typed /pulls route reads the poster filter from the `author` query.
      author: "poster" in o ? o.poster : undefined,
      labels: "labels" in o ? o.labels?.join(",") : undefined,
    });
    return r.pulls ?? [];
  }

  async getPull(owner: string, repo: string, index: number): Promise<PrMeta | null> {
    const r = await this.getOrNull<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}`));
    return r ? r.pull : null;
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

  async listPullFiles(owner: string, repo: string, index: number): Promise<PrFile[]> {
    const r = await this.get<{ files: PrFile[] }>(this.repoPath(owner, repo, `/pulls/${index}/files`));
    return r.files ?? [];
  }

  async listPullCommits(owner: string, repo: string, index: number): Promise<PrCommit[]> {
    const r = await this.get<{ commits: PrCommit[] }>(this.repoPath(owner, repo, `/pulls/${index}/commits`));
    return r.commits ?? [];
  }

  async listPullComments(owner: string, repo: string, index: number): Promise<LineComment[]> {
    const r = await this.get<{ comments: LineComment[] }>(this.repoPath(owner, repo, `/pulls/${index}/comments`));
    return r.comments ?? [];
  }

  async listReviews(owner: string, repo: string, index: number): Promise<ReviewDto[]> {
    const r = await this.get<{ reviews: ReviewDto[] }>(this.repoPath(owner, repo, `/pulls/${index}/reviews`));
    return r.reviews ?? [];
  }

  // ---- pull / review writes ----

  // The typed create route returns the PR metadata directly; it also de-dupes an
  // existing head→base PR to 200. On a genuine empty-diff/validation reject it
  // 409s, which surfaces here as a status-bearing error.
  async createPull(
    owner: string,
    repo: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<PrMeta> {
    const r = await this.post<PrMeta>(this.repoPath(owner, repo, "/pulls"), opts);
    return r;
  }

  // The forge editPull is one method; the typed API splits labels and state into
  // separate routes. Title/body/milestone share PATCH /pulls/:number.
  async editPull(
    owner: string,
    repo: string,
    index: number,
    patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: number[]; milestone?: number },
  ): Promise<PrMeta> {
    let pull: PrMeta | undefined;
    if (patch.title !== undefined || patch.body !== undefined || patch.milestone !== undefined) {
      const tb: { title?: string; body?: string; milestone?: number | null } = {};
      if (patch.title !== undefined) tb.title = patch.title;
      if (patch.body !== undefined) tb.body = patch.body;
      if (patch.milestone !== undefined) tb.milestone = patch.milestone === 0 ? null : patch.milestone;
      const r = await this.patch<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}`), tb);
      pull = r.pull;
    }
    if (patch.labels !== undefined) {
      const r = await this.put<{ pull: PrMeta }>(this.repoPath(owner, repo, `/pulls/${index}/labels`), { labels: patch.labels });
      pull = r.pull;
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
  ): Promise<ReviewDto> {
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
      return { id: reviewId, username: "", decision: reviewStateToDecision(opts.event), comment: opts.body || null, created_at: 0 };
    }
    if (opts.event === "PENDING") {
      const r = await this.post<{ review_id: number }>(this.repoPath(owner, repo, `/pulls/${index}/pending-review`), {});
      return { id: r.review_id, username: "", decision: "pending", comment: opts.body || null, created_at: 0 };
    }
    const event = opts.event === "APPROVED" ? "APPROVE" : opts.event;
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/reviews`), { event, body: opts.body });
    return { id: 0, username: "", decision: reviewStateToDecision(opts.event), comment: opts.body || null, created_at: 0 };
  }

  // Submit a previously-created pending review; the typed route takes a
  // lowercase verdict and returns {ok}. Callers ignore the return.
  async submitPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts: { event: ReviewSubmitEvent; body: string },
  ): Promise<ReviewDto> {
    const event = opts.event === "APPROVED" ? "approve" : opts.event === "REQUEST_CHANGES" ? "request_changes" : "comment";
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/submit`), {
      event,
      body: opts.body,
    });
    return { id: reviewId, username: "", decision: reviewStateToDecision(opts.event), comment: opts.body || null, created_at: 0 };
  }

  // Add an inline comment to an existing pending review. The shared route already
  // resolved the diff anchor to forge positions (new_position/old_position), so
  // this forwards those to the typed pending-review review-comments route, which
  // maps them straight onto the core's addCommentToReview. The forge returns the
  // created comment, but every caller ignores it, so a minimal DTO is synthesized
  // from the inputs.
  async addCommentToReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts: { path: string; body: string; new_position?: number; old_position?: number },
  ): Promise<LineComment> {
    await this.post(this.repoPath(owner, repo, `/pulls/${index}/pending-review/${reviewId}/review-comments`), {
      path: opts.path,
      body: opts.body,
      ...(opts.new_position !== undefined ? { new_position: opts.new_position } : {}),
      ...(opts.old_position !== undefined ? { old_position: opts.old_position } : {}),
    });
    return {
      id: 0,
      review_id: reviewId,
      path: opts.path,
      body: opts.body,
      line: opts.new_position ?? opts.old_position ?? null,
      side: opts.new_position !== undefined ? "head" : "base",
      author_username: "",
      created_at: 0,
      updated_at: 0,
      outdated: false,
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
    return this.get<BranchRow[]>(this.repoPath(owner, repo, "/branches"));
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

  async searchUsers(query: string, limit = 10): Promise<Array<{ login: string }>> {
    const needle = query.toLowerCase();
    const repos: { workspaces?: Array<{ owner?: string; repo?: string }> } = await this.get<{ workspaces?: Array<{ owner?: string; repo?: string }> }>("/api/v1/workspaces").catch(() => ({}));
    const seen = new Set<string>();
    for (const workspace of repos.workspaces ?? []) {
      if (!workspace.owner || !workspace.repo) continue;
      const collaborators = await this.listCollaborators(workspace.owner, workspace.repo).catch(() => []);
      for (const collaborator of collaborators) {
        if (collaborator.login.toLowerCase().includes(needle)) seen.add(collaborator.login);
      }
      if (seen.size >= limit) break;
    }
    return [...seen].slice(0, limit).map((login) => ({ login }));
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

  // The typed surface exposes only the main-branch review policy via /settings.
  // Do not label that policy as applying to another base branch.
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionShape | null> {
    if (branch !== "main") return null;
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

  // The typed feed is already filtered to unread Issue/Pull rows, so the
  // forge-style status/subject opts are accepted for signature parity.
  async listRepoNotifications(
    owner: string,
    repo: string,
    _opts: { statusTypes?: readonly string[]; subjectTypes?: readonly string[] } = {},
  ): Promise<NotificationRow[]> {
    const r = await this.get<{ notifications: NotificationRow[] }>(this.repoPath(owner, repo, "/notifications"));
    return r.notifications ?? [];
  }

  async listRepoActivities(owner: string, repo: string, opts: { limit?: number } = {}): Promise<ActivityRow[]> {
    const r = await this.get<{ activities: ActivityRow[] }>(this.repoPath(owner, repo, "/activities"), {
      limit: opts.limit,
    });
    return r.activities ?? [];
  }

  // ---- notification writes ----

  // Resolve a single notification thread by its global forge id. A non-issue/
  // pull or unreadable thread 404s, which callers degrade to not-found.
  async getNotificationThread(id: number): Promise<NotificationRow> {
    const r = await this.get<{ notification: NotificationRow }>(`/api/v1/notifications/threads/${id}`);
    return r.notification;
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

  // The core exposes no per-user permission endpoint. The sole caller (the PR
  // reviewer-permission column) treats "none" as "unknown" and renders empty, so
  // returning "none" fully implements the seam without a stub-Proxy layer.
  async getRepoPermission(_owner: string, _repo: string, _user: string): Promise<Role | "none"> {
    return "none";
  }
}

// The collaboration source for a local workspace: the connected core via the
// Origin API, or the unconnected sentinel. OriginCollaborationClient implements
// the full CollaborationClient surface, so it satisfies the seam directly — no
// stub Proxy.
export function localCollaborationClient(entry: WorkspaceEntry): CollaborationClient {
  if (entry.remote) {
    return new OriginCollaborationClient(entry.remote.url, entry.remote.token);
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
