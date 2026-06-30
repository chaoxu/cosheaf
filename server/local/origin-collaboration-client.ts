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
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  NotificationRow,
  TimelineEvent,
} from "../../shared/issues.js";
import type { PrFile, PrMeta } from "../../shared/review.js";
import type { CollaborationClient } from "../collaboration-client.js";
import { RemoteCosheafError } from "./remote-cosheaf-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

// The forge-client object shapes, derived from the CollaborationClient surface so
// no forge type is named in this Workbench file. Each is the element the matching
// read method resolves to.
type IssueShape = Awaited<ReturnType<CollaborationClient["getIssue"]>>;
type CommentShape = Awaited<ReturnType<CollaborationClient["listIssueComments"]>>[number];
type LabelShape = Awaited<ReturnType<CollaborationClient["listLabels"]>>[number];
type MilestoneShape = Awaited<ReturnType<CollaborationClient["listMilestones"]>>[number];
type TimelineShape = Awaited<ReturnType<CollaborationClient["listIssueTimeline"]>>[number];
// pulls / reviews / repo / notifications surfaces (this pass).
type PullShape = NonNullable<Awaited<ReturnType<CollaborationClient["getPull"]>>>;
type ReviewShape = Awaited<ReturnType<CollaborationClient["listReviews"]>>[number];
type PullFileShape = Awaited<ReturnType<CollaborationClient["listPullFiles"]>>[number];
type PullCommentShape = Awaited<ReturnType<CollaborationClient["listPullComments"]>>[number];
type BranchShape = Awaited<ReturnType<CollaborationClient["listBranches"]>>[number];
type RepoShape = NonNullable<Awaited<ReturnType<CollaborationClient["getRepo"]>>>;
type BranchProtectionShape = NonNullable<Awaited<ReturnType<CollaborationClient["getBranchProtection"]>>>;
type NotificationThreadShape = Awaited<ReturnType<CollaborationClient["listRepoNotifications"]>>[number];

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

// Cosheaf DTOs serialize timestamps as epoch-ms; the forge shapes carry ISO-8601
// strings (which the routes immediately re-parse with toEpochMs). Round-trip
// faithfully: 0 → the epoch, which re-parses back to 0.
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

// Cosheaf Label DTO → label shape. `scope` has no forge-shape equivalent and the
// issue routes don't read it, so it's dropped.
function toLabelShape(label: Label): LabelShape {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    exclusive: label.exclusive,
    is_archived: label.is_archived,
  };
}

// The compact list-row DTO carries no body/assignees/milestone/closed_at; the
// issue routes' toIssueRow doesn't read those, so synthesize empties.
function issueRowToShape(row: IssueRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: { id: 0, login: row.author_username },
    assignees: null,
    labels: row.labels.map(toLabelShape),
    milestone: null,
    comments: row.comment_count,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    closed_at: null,
    // pull_request omitted: the typed API is issue-only, so the routes'
    // !pull_request filter passes.
  };
}

function issueDetailToShape(d: IssueDetail): IssueShape {
  return {
    id: d.number,
    number: d.number,
    title: d.title,
    body: d.body,
    state: d.state,
    user: { id: 0, login: d.author_username },
    assignees: d.assignees.map((login) => ({ id: 0, login })),
    labels: d.labels.map(toLabelShape),
    // The detail DTO exposes only {id,title}; milestone.state isn't read by the
    // issue routes (they take {id,title}), so default it.
    milestone: d.milestone ? { id: d.milestone.id, title: d.milestone.title, state: "open" } : null,
    comments: d.comment_count,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    closed_at: isoOrNull(d.closed_at),
  };
}

// The pinned DTO is compact (no labels/created_at/body); routes that consume
// pinned issues read number/title/state/comments/updated_at/author only.
interface PinnedRow {
  number: number;
  title: string;
  state: "open" | "closed";
  comment_count: number;
  updated_at: number;
  author_username: string;
}
function pinnedRowToShape(row: PinnedRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: { id: 0, login: row.author_username },
    assignees: null,
    labels: [],
    milestone: null,
    comments: row.comment_count,
    created_at: iso(row.updated_at),
    updated_at: iso(row.updated_at),
    closed_at: null,
  };
}

// Dependency/block rows carry only number/title/state/is_pr; the routes'
// toDependencyRow reads exactly those (is_pr via !!pull_request).
function dependencyRowToShape(row: DependencyRow): IssueShape {
  return {
    id: row.number,
    number: row.number,
    title: row.title,
    body: "",
    state: row.state,
    user: null,
    assignees: null,
    labels: [],
    milestone: null,
    comments: 0,
    created_at: "",
    updated_at: "",
    closed_at: null,
    pull_request: row.is_pr ? {} : undefined,
  };
}

function commentToShape(cm: IssueComment): CommentShape {
  return {
    id: cm.id,
    body: cm.body,
    user: { id: 0, login: cm.author_username },
    created_at: iso(cm.created_at),
    updated_at: iso(cm.updated_at),
  };
}

function milestoneToShape(m: Milestone): MilestoneShape {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    state: m.state,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: isoOrNull(m.due_on),
    // created_at is required on the shape but unread by toMilestone.
    created_at: "",
  };
}

function timelineToShape(e: TimelineEvent): TimelineShape {
  return {
    id: e.id,
    type: e.type,
    user: e.author_username ? { id: 0, login: e.author_username } : undefined,
    body: e.body ?? undefined,
    created_at: iso(e.created_at),
    updated_at: e.updated_at === null ? undefined : iso(e.updated_at),
    label: e.label ? { id: 0, name: e.label.name, color: e.label.color } : undefined,
    old_title: e.old_title ?? undefined,
    new_title: e.new_title ?? undefined,
    assignee: e.assignee ? { id: 0, login: e.assignee } : undefined,
    removed_assignee: e.removed_assignee,
    // Routes read ref_issue.pull_request (null/object) + .merged. Invert the
    // flattened is_pull/pull_merged the DTO carries.
    ref_issue: e.ref_issue
      ? {
          number: e.ref_issue.number,
          title: e.ref_issue.title ?? undefined,
          state: e.ref_issue.state ?? undefined,
          pull_request: e.ref_issue.is_pull ? { merged: e.ref_issue.pull_merged ?? false } : null,
        }
      : undefined,
    ref_action: e.ref_action ?? undefined,
    ref_commit_sha: e.ref_commit_sha ?? undefined,
    milestone: e.milestone ? { id: 0, title: e.milestone } : undefined,
    dependent_issue: e.dependent_issue
      ? { id: 0, number: e.dependent_issue.number, title: e.dependent_issue.title, state: e.dependent_issue.state }
      : undefined,
  };
}

// ----- pulls / reviews -----

// The typed PR DTO drops the forge pull `id`, the issue-style comment count, and
// `updated_at`; the pull surfaces don't read `id`/`updated_at` and render the
// missing comment count as 0 (its own list-row fallback). head `label` is unread.
function prMetaToPullShape(p: PrMeta): PullShape {
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
    comments: 0,
    created_at: iso(p.created_at),
    updated_at: iso(p.created_at),
  };
}

// The typed reviews endpoint flattens to a verdict DTO (and pre-filters out
// PENDING/DISMISSED). Re-expand `decision` to the forge review state the
// timeline reads; `comment` (nullable) becomes the review body.
interface ReviewDto {
  id: number;
  username: string;
  decision: "approve" | "request_changes" | "comment";
  comment: string | null;
  created_at: number;
}
function reviewDtoToShape(r: ReviewDto): ReviewShape {
  const state =
    r.decision === "approve" ? "APPROVED" : r.decision === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
  return {
    id: r.id,
    body: r.comment ?? "",
    state,
    user: { id: 0, login: r.username },
    submitted_at: iso(r.created_at),
  };
}

function prFileToShape(f: PrFile): PullFileShape {
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
function lineCommentToShape(cm: LineComment): PullCommentShape {
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

// The /branches list returns a branch object (the local content backend's
// WsBranch, plus a commit `url`); the pull/settings surfaces read only `name`.
interface BranchJson {
  name: string;
  commit?: { id?: string; timestamp?: string; author?: { username?: string; name?: string; email?: string } };
}
function branchToShape(b: BranchJson): BranchShape {
  return { name: b.name, commit: { id: b.commit?.id ?? "", timestamp: b.commit?.timestamp, author: b.commit?.author } };
}

// ----- notifications -----

// NotificationRow is already the mapped repo-notification DTO; rebuild the
// thread shape the notification routes re-map. The typed feed is unread-only, so
// `unread` is true and `pinned` false. Synthesize a subject url carrying the
// issue/pull number so the routes' number-from-url parse still resolves.
function notificationRowToShape(row: NotificationRow): NotificationThreadShape {
  const type = row.kind === "pr" ? "Pull" : "Issue";
  const segment = row.kind === "pr" ? "pulls" : "issues";
  const name = row.repo.includes("/") ? row.repo.slice(row.repo.indexOf("/") + 1) : row.repo;
  return {
    id: row.id,
    unread: true,
    pinned: false,
    updated_at: iso(row.updated_at),
    url: "",
    subject: {
      title: row.title,
      url: `/${segment}/${row.number}`,
      latest_comment_url: "",
      html_url: row.url,
      type,
    },
    repository: { full_name: row.repo, name },
  };
}

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

  private async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await this.fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RemoteCosheafError(res.status, `remote cosheaf ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RemoteCosheafError(res.status, `remote cosheaf ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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

  async listPullComments(owner: string, repo: string, index: number): Promise<PullCommentShape[]> {
    const r = await this.get<{ comments: LineComment[] }>(this.repoPath(owner, repo, `/pulls/${index}/comments`));
    return (r.comments ?? []).map(lineCommentToShape);
  }

  async listReviews(owner: string, repo: string, index: number): Promise<ReviewShape[]> {
    const r = await this.get<{ reviews: ReviewDto[] }>(this.repoPath(owner, repo, `/pulls/${index}/reviews`));
    return (r.reviews ?? []).map(reviewDtoToShape);
  }

  // ---- repo / settings reads ----

  async listBranches(owner: string, repo: string): Promise<BranchShape[]> {
    const r = await this.get<BranchJson[]>(this.repoPath(owner, repo, "/branches"));
    return (r ?? []).map(branchToShape);
  }

  async getRepo(owner: string, repo: string): Promise<RepoShape | null> {
    // The typed repo route returns a forge-repo-compatible object (description,
    // visibility, default branch, owner, topics-when-present).
    return this.getOrNull<RepoShape>(this.repoPath(owner, repo, ""));
  }

  // The typed surface exposes only the main-branch review policy via /settings;
  // every caller reads this for "main", and `min_approvals` is that branch's
  // required-approvals count.
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtectionShape | null> {
    const r = await this.get<{ min_approvals: number }>(this.repoPath(owner, repo, "/settings"));
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
}

// Wrap a read-capable origin client so every not-yet-implemented
// CollaborationClient method throws clearly instead of being `undefined`. #263
// lands the issue reads; write methods and the pulls/notifications/repo/settings
// surfaces arrive with their owning agents. Implemented methods delegate (bound
// to the real instance so their internal `this.get` works); anything else is a
// loud stub. The cast is the "cast unimplemented methods" the seam allows.
function withUnimplementedStubs(client: OriginCollaborationClient): CollaborationClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return () => {
        throw new Error(`OriginCollaborationClient.${String(prop)} is not implemented yet`);
      };
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
