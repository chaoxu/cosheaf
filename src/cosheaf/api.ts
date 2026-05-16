import type { BranchState, ChangeState, Decision } from "../../shared/change-lifecycle";
import type { Role } from "../../shared/roles";
import type { ChangeDiff, PrMeta, PullFile } from "../../shared/review";
import type { LineComment, CommentSide } from "../../shared/comments";

export type { BranchState, Decision, Role, ChangeDiff, PullFile, PrMeta, LineComment, CommentSide };
/** @deprecated use BranchState */
export type { ChangeState };

export interface User {
  id: number;
  username: string;
  forgejo_username: string;
}

export interface Workspace {
  id: number;
  slug: string;
  name: string;
  role: Role;
}

export interface DocumentMeta {
  id: string;
  type: "page";
  status: "golden";
  title: string | null;
}

export interface FileEntry {
  path: string;
  size: number;
  doc?: DocumentMeta;
}

export interface NoteContent {
  content: string;
}

export interface Branch {
  id: string;
  workspace_id: number;
  author_user_id: number;
  branch_name: string;
  state: BranchState;
  pr_number: number | null;
  base_sha: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}
/** @deprecated use Branch */
export type Change = Branch;

export interface ReviewQueueEntry {
  id: string;
  title: string;
  pr_number: number | null;
  author_user_id: number;
  created_at: number;
  approvals: number;
  rejections: number;
}
/** @deprecated use ReviewQueueEntry */
export type QueueEntry = ReviewQueueEntry;

export interface ApprovalRecord {
  verifier_user_id: number;
  username: string;
  decision: Decision;
  comment: string | null;
  created_at: number;
}

export interface Backlink {
  src_id: string;
  src_path: string;
  src_title: string | null;
  target_label: string;
}

export interface SearchResult {
  doc_id: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  target_id: string | null;
  snippet: Array<{ text: string; match: boolean }>;
  rank: number;
}

export interface TokenInfo {
  id: number;
  name: string;
  created_at: number;
}

export interface PublishResult {
  ok: boolean;
  mode?: "direct" | "review";
  branchId?: string;
  pr_number?: number;
  message?: string;
}

export interface DecisionResult {
  decision: Exclude<Decision, "comment">;
  branchId: string;
  state: BranchState;
  approvals: number;
  rejections: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const w = (slug: string): string => `/api/v1/w/${encodeURIComponent(slug)}`;
const qs = (params: Record<string, string | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&")}` : "";
};

export const api = {
  me: () => jsonFetch<{ user: User | null }>("/api/v1/me"),
  login: (username: string, password: string) =>
    jsonFetch<User>("/api/v1/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => jsonFetch<{ ok: true }>("/api/v1/logout", { method: "POST" }),

  listWorkspaces: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/v1/workspaces").then((r) => r.workspaces),
  createWorkspace: (slug: string, name: string) =>
    jsonFetch<Workspace>("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ slug, name }),
    }),

  tree: (slug: string, branchId?: string) =>
    jsonFetch<{ files: FileEntry[] }>(`${w(slug)}/tree${qs({ branchId })}`).then((r) => r.files),

  getFile: (slug: string, path: string, branchId?: string) =>
    jsonFetch<NoteContent>(`${w(slug)}/file${qs({ path, branchId })}`),
  putFile: (slug: string, path: string, content: string, branchId?: string) =>
    jsonFetch<{ ok: true; branchId: string; meta: DocumentMeta; content?: string; pending?: boolean }>(
      `${w(slug)}/file${qs({ path, branchId })}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  deleteFile: (slug: string, path: string, branchId?: string) =>
    jsonFetch<{ ok: true; branchId: string; pending: boolean }>(
      `${w(slug)}/file${qs({ path, branchId })}`,
      { method: "DELETE" },
    ),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(`${w(slug)}/backlinks${qs({ id })}`).then((r) => r.backlinks),
  search: (slug: string, q: string) =>
    jsonFetch<{ results: SearchResult[] }>(`${w(slug)}/search${qs({ q })}`).then((r) => r.results),

  // Branches / pull requests
  branches: (slug: string) =>
    jsonFetch<{ changes: Branch[] }>(`${w(slug)}/branches`).then((r) => r.changes),
  createBranch: (slug: string, title?: string) =>
    jsonFetch<Branch>(`${w(slug)}/branch`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  discard: (slug: string, branchId: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/branch/${encodeURIComponent(branchId)}`, { method: "DELETE" }),
  publish: (slug: string, branchId: string, mode?: "direct" | "review", title?: string) =>
    jsonFetch<PublishResult>(`${w(slug)}/publish`, {
      method: "POST",
      body: JSON.stringify({ branchId, mode, title }),
    }),
  /** @deprecated Use `api.submitReview(slug, prNumber, "APPROVE", body)` (Forgejo-shape). */
  approve: (slug: string, branchId: string, comment?: string) =>
    jsonFetch<DecisionResult>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? null }),
    }),
  /** @deprecated Use `api.submitReview(slug, prNumber, "REQUEST_CHANGES", body)` (Forgejo-shape). */
  requestChanges: (slug: string, branchId: string, comment?: string) =>
    jsonFetch<DecisionResult>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? null }),
    }),
  /** @deprecated Use `api.submitReview(slug, prNumber, "COMMENT", body)` (Forgejo-shape). */
  comment: (slug: string, branchId: string, comment?: string) =>
    jsonFetch<{ ok: true; branchId: string; state: Branch["state"] }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/comment`,
      { method: "POST", body: JSON.stringify({ comment: comment ?? null }) },
    ),
  close: (slug: string, branchId: string) =>
    jsonFetch<{ ok: true; branchId: string; state: Branch["state"] }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/close`,
      { method: "POST" },
    ),
  /** @deprecated Use `api.listReviews(slug, prNumber)` (Forgejo-shape). */
  approvals: (slug: string, branchId: string) =>
    jsonFetch<{ approvals: ApprovalRecord[] }>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/approvals`).then((r) => r.approvals),

  reviewQueue: (slug: string) =>
    jsonFetch<{ queue: ReviewQueueEntry[] }>(`${w(slug)}/review-queue`).then((r) => r.queue),
  /** @deprecated Use `api.listPulls(slug, "open")` (Forgejo-shape). */
  openBranches: (slug: string) =>
    jsonFetch<{ changes: OpenBranchRow[] }>(`${w(slug)}/branches/open`).then((r) => r.changes),

  /** @deprecated Use `api.getPull(slug, prNumber)` (Forgejo-shape, returns raw Forgejo PR + cosheaf extras). */
  pr: (slug: string, branchId: string) =>
    jsonFetch<{ pr: PrMeta }>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/pr`).then((r) => r.pr),
  /** @deprecated Use `api.listPullFiles(slug, prNumber)` (Forgejo-shape, same per-file body). */
  diff: (slug: string, branchId: string) =>
    jsonFetch<ChangeDiff>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/diff`),

  // ---------- Forgejo-shape endpoints (preferred) ----------

  /** POST /pulls/{n}/reviews — Forgejo-shape review submission. */
  submitReview: (
    slug: string,
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string | null,
  ) =>
    jsonFetch<unknown>(`${w(slug)}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event, body: body ?? null }),
    }),
  /** GET /pulls/{n}/reviews — same shape as the deprecated `api.approvals`. */
  listReviews: (slug: string, prNumber: number) =>
    jsonFetch<{ approvals: ApprovalRecord[] }>(`${w(slug)}/pulls/${prNumber}/reviews`).then(
      (r) => r.approvals,
    ),
  /** GET /pulls/{n} — Forgejo PR object plus cosheaf extras (head_sha, base_sha, …). */
  getPull: (slug: string, prNumber: number) =>
    jsonFetch<Record<string, unknown>>(`${w(slug)}/pulls/${prNumber}`),
  /** GET /pulls/{n}/files — same per-file split-patch shape as the deprecated `api.diff`. */
  listPullFiles: (slug: string, prNumber: number) =>
    jsonFetch<ChangeDiff>(`${w(slug)}/pulls/${prNumber}/files`),
  /** GET /pulls?state=open|closed|all — Forgejo-shape PR listing (returns `{ changes }`). */
  listPulls: (slug: string, state: "open" | "closed" | "all" = "open") =>
    jsonFetch<{ changes: OpenBranchRow[] }>(`${w(slug)}/pulls?state=${state}`).then(
      (r) => r.changes,
    ),

  file: (slug: string, branchId: string, path: string, side: "base" | "head") =>
    jsonFetch<{ content: string }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/file?path=${encodeURIComponent(path)}&side=${side}`,
    ).then((r) => r.content),
  comments: (slug: string, branchId: string) =>
    jsonFetch<{ comments: LineComment[] }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/comments`,
    ).then((r) => r.comments),
  addComment: (
    slug: string,
    branchId: string,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/branch/${encodeURIComponent(branchId)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  editComment: (slug: string, branchId: string, commentId: number, body: string) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ),
  deleteComment: (slug: string, branchId: string, commentId: number, reviewId: number) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/comments/${commentId}?review_id=${reviewId}`,
      { method: "DELETE" },
    ),
  startDraftReview: (slug: string, branchId: string) =>
    jsonFetch<{ review_id: number }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/draft-review`,
      { method: "POST" },
    ),
  addDraftReviewComment: (
    slug: string,
    branchId: string,
    review_id: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/draft-review/${review_id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  submitDraftReview: (
    slug: string,
    branchId: string,
    review_id: number,
    payload: { event: "approve" | "request_changes" | "comment"; body?: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/branch/${encodeURIComponent(branchId)}/draft-review/${review_id}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),

  listTokens: () =>
    jsonFetch<{ tokens: TokenInfo[] }>("/api/v1/tokens").then((r) => r.tokens),
  createToken: (name: string) =>
    jsonFetch<{ id: number; name: string; token: string }>("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: number) =>
    jsonFetch<{ ok: true }>(`/api/v1/tokens/${id}`, { method: "DELETE" }),

  // ---- issues ----
  listIssues: (
    slug: string,
    opts: { state?: "open" | "closed" | "all"; filter?: "mine" | "assigned" | "all"; q?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.state) qs.set("state", opts.state);
    if (opts.filter) qs.set("filter", opts.filter);
    if (opts.q && opts.q.trim()) qs.set("q", opts.q.trim());
    const q = qs.toString();
    return jsonFetch<{ issues: IssueRow[] }>(`${w(slug)}/issues${q ? `?${q}` : ""}`);
  },
  getIssue: (slug: string, number: number) =>
    jsonFetch<IssueDetail>(`${w(slug)}/issues/${number}`),
  getIssueComments: (slug: string, number: number) =>
    jsonFetch<{ comments: IssueComment[] }>(`${w(slug)}/issues/${number}/comments`),
  createIssue: (slug: string, body: { title: string; body: string }) =>
    jsonFetch<{ number: number; title: string; state: "open" | "closed" }>(
      `${w(slug)}/issues`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  closeIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true; state: "closed" }>(`${w(slug)}/issues/${number}/close`, { method: "POST" }),
  reopenIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true; state: "open" }>(`${w(slug)}/issues/${number}/reopen`, { method: "POST" }),
  createIssueComment: (slug: string, number: number, body: string) =>
    jsonFetch<IssueComment>(`${w(slug)}/issues/${number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  editIssueComment: (slug: string, number: number, id: number, body: string) =>
    jsonFetch<{ id: number; body: string; updated_at: number }>(
      `${w(slug)}/issues/${number}/comments/${id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) },
    ),
  deleteIssueComment: (slug: string, number: number, id: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/comments/${id}`, { method: "DELETE" }),
  listLabels: (slug: string) =>
    jsonFetch<{ labels: Label[] }>(`${w(slug)}/labels`),
  createLabel: (slug: string, body: { name: string; color: string; description?: string }) =>
    jsonFetch<Label>(`${w(slug)}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  setIssueLabels: (slug: string, number: number, labels: number[]) =>
    jsonFetch<{ labels: Label[] }>(`${w(slug)}/issues/${number}/labels`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    }),
  listPinnedIssues: (slug: string) =>
    jsonFetch<{ issues: IssueRow[] }>(`${w(slug)}/issues/pinned`),
  pinIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/pin`, { method: "POST" }),
  unpinIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/pin`, { method: "DELETE" }),
  getIssueTimeline: (slug: string, number: number) =>
    jsonFetch<{ events: TimelineEvent[] }>(`${w(slug)}/issues/${number}/timeline`),
  listActivities: (slug: string, limit = 50) =>
    jsonFetch<{ activities: ActivityRow[] }>(`${w(slug)}/activities?limit=${limit}`),
  listIssueDependencies: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/dependencies`),
  listIssueBlocks: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/blocks`),
  addIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }),
  removeIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/dependencies/${index}`, { method: "DELETE" }),
  listMilestones: (slug: string, state: "open" | "closed" | "all" = "open") =>
    jsonFetch<{ milestones: Milestone[] }>(`${w(slug)}/milestones?state=${state}`),
  createMilestone: (slug: string, body: { title: string; description?: string }) =>
    jsonFetch<{ id: number; title: string; state: "open" | "closed" }>(`${w(slug)}/milestones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  setIssueMilestone: (slug: string, number: number, id: number | null) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/milestone`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),

  // ---- notifications ----
  listNotifications: (slug: string) =>
    jsonFetch<{ notifications: NotificationRow[] }>(`${w(slug)}/notifications`).then(
      (r) => r.notifications,
    ),
  markNotificationRead: (slug: string, id: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: (slug: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/notifications/read-all`, { method: "POST" }),
};

// Shared response shapes live in shared/issues.ts — single source of truth
// for the server's response builders and these client types.
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
} from "../../shared/issues";
export type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  NotificationRow,
  TimelineEvent,
};

export interface OpenBranchRow {
  id: string;
  title: string | null;
  state: "review" | "changes_requested";
  pr_number: number | null;
  author_user_id: number;
  updated_at: number;
}
/** @deprecated use OpenBranchRow */
export type OpenChangeRow = OpenBranchRow;
