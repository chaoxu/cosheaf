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

import type {
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  TimelineEvent,
} from "../../shared/issues.js";
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
