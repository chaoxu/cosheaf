import type { Role } from "../../shared/roles";
import type { ChangeDiff, PrMeta, PrState, PullFile } from "../../shared/review";
import type { LineComment, CommentSide } from "../../shared/comments";

export type Decision = "approve" | "request_changes" | "comment";
export type { Role, ChangeDiff, PullFile, PrMeta, PrState, LineComment, CommentSide };

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
  name: string;
  commit_sha: string | null;
  updated_at: number;
}
/** @deprecated use Branch */
export type Change = Branch;

// Queue + open-PR rows are now thin views over the Forgejo PrMeta. Old
// cosheaf-side fields (`id`, `author_user_id`, `state ∈ {review, changes_requested}`,
// approvals) have been replaced by Forgejo's PR number, author_username,
// open/closed + `merged: boolean`, and a derived approvals count fetched
// alongside.
export type ReviewQueueEntry = PrMeta & { approvals: number; rejections: number };
export type OpenBranchRow = PrMeta;

export interface ApprovalRecord {
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
  ok: true;
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

  tree: (slug: string, branch?: string) =>
    jsonFetch<{ files: FileEntry[] }>(`${w(slug)}/tree${qs({ branch })}`).then((r) => r.files),

  getFile: (slug: string, path: string, branch?: string) =>
    jsonFetch<NoteContent>(`${w(slug)}/file${qs({ path, branch })}`),
  putFile: (slug: string, path: string, content: string, branch: string) =>
    jsonFetch<{ ok: true; branch: string; meta: DocumentMeta; content?: string; commit?: string }>(
      `${w(slug)}/file${qs({ path, branch })}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  deleteFile: (slug: string, path: string, branch: string) =>
    jsonFetch<{ ok: true; branch: string }>(`${w(slug)}/file${qs({ path, branch })}`, {
      method: "DELETE",
    }),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(`${w(slug)}/backlinks${qs({ id })}`).then((r) => r.backlinks),
  search: (slug: string, q: string) =>
    jsonFetch<{ results: SearchResult[] }>(`${w(slug)}/search${qs({ q })}`).then((r) => r.results),

  // ---------- Branches (your in-progress branches, no open PR) ----------

  myBranches: (slug: string) =>
    jsonFetch<{ branches: Branch[] }>(`${w(slug)}/branches/mine`).then((r) => r.branches),
  createBranch: (slug: string, name: string) =>
    jsonFetch<{ name: string }>(`${w(slug)}/branches`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteBranch: (slug: string, name: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/branches/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // ---------- Pulls (Forgejo-shape) ----------

  listPulls: (slug: string, state: "open" | "closed" | "all" = "open") =>
    jsonFetch<{ pulls: PrMeta[] }>(`${w(slug)}/pulls?state=${state}`).then((r) => r.pulls),
  openPull: (
    slug: string,
    payload: { head: string; base?: string; title?: string; body?: string },
  ) =>
    jsonFetch<PrMeta>(`${w(slug)}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getPull: (slug: string, prNumber: number) =>
    jsonFetch<PrMeta>(`${w(slug)}/pulls/${prNumber}`),
  mergePull: (
    slug: string,
    prNumber: number,
    opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: opts.Do ?? "squash", force: opts.force ?? false }),
    }),
  closePull: (slug: string, prNumber: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/close`, { method: "POST" }),

  listPullFiles: (slug: string, prNumber: number) =>
    jsonFetch<ChangeDiff>(`${w(slug)}/pulls/${prNumber}/files`),
  pullFile: (slug: string, prNumber: number, path: string, side: "base" | "head") =>
    jsonFetch<{ content: string }>(
      `${w(slug)}/pulls/${prNumber}/file?path=${encodeURIComponent(path)}&side=${side}`,
    ).then((r) => r.content),

  submitReview: (
    slug: string,
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string | null,
  ) =>
    jsonFetch<DecisionResult>(`${w(slug)}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event, body: body ?? null }),
    }),
  listReviews: (slug: string, prNumber: number) =>
    jsonFetch<{ reviews: ApprovalRecord[]; approvals: number; rejections: number }>(
      `${w(slug)}/pulls/${prNumber}/reviews`,
    ),

  // ---------- Line comments on a PR ----------

  listComments: (slug: string, prNumber: number) =>
    jsonFetch<{ comments: LineComment[] }>(`${w(slug)}/pulls/${prNumber}/comments`).then((r) => r.comments),
  addComment: (
    slug: string,
    prNumber: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  editComment: (slug: string, prNumber: number, commentId: number, body: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),
  deleteComment: (slug: string, prNumber: number, commentId: number, reviewId: number) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/comments/${commentId}?review_id=${reviewId}`,
      { method: "DELETE" },
    ),

  startDraftReview: (slug: string, prNumber: number) =>
    jsonFetch<{ review_id: number }>(`${w(slug)}/pulls/${prNumber}/draft-review`, { method: "POST" }),
  addDraftReviewComment: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/draft-review/${reviewId}/comments`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  submitDraftReview: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { event: "approve" | "request_changes" | "comment"; body?: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/draft-review/${reviewId}/submit`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  // ---------- Workspace settings ----------

  getSettings: (slug: string) => jsonFetch<{ min_approvals: number }>(`${w(slug)}/settings`),
  updateSettings: (slug: string, body: { min_approvals: number }) =>
    jsonFetch<{ min_approvals: number }>(`${w(slug)}/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

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

