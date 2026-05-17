import type { Role } from "../../shared/roles";
import type { PrFiles, PrMeta, PrState, PrFile } from "../../shared/review";
import type { LineComment, CommentSide } from "../../shared/comments";
import type { WorkspaceValidation } from "../../shared/validation";
import type { DocumentFormatId } from "../../shared/document-format";
import type {
  ForgejoIssueCommentRaw,
  ForgejoMilestoneRef,
  ForgejoPullRaw,
} from "../../shared/forgejo-shapes";

export type Decision = "approve" | "request_changes" | "comment";
export type { Role, PrFiles, PrFile, PrMeta, PrState, LineComment, CommentSide };

export interface User {
  id: number;
  username: string;
}

export interface Workspace {
  id: number;
  slug: string;
  name: string;
  role: Role;
  default_md_format: DocumentFormatId;
}

export interface WorkspaceSettings {
  min_approvals: number;
  default_md_format: DocumentFormatId;
  formats: Array<{ id: DocumentFormatId; displayName: string }>;
}

export interface DocumentMeta {
  id: string;
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
// Open-PR list = Forgejo PrMeta as-is. Queue entries add cached approval
// counts so the sidebar can render the gate without a per-row fetch.
export type OpenPull = PrMeta;
export type PullReviewEntry = PrMeta & { approvals: number; rejections: number };

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
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    // Forgejo rejected the stored PAT. Server has already wiped the session;
    // bounce the page so the SPA re-mounts and lands on the login form.
    if (res.status === 401 && body.code === "pat_invalid" && typeof window !== "undefined") {
      window.location.reload();
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const w = (slug: string): string => `/api/v1/w/${encodeURIComponent(slug)}`;
const forgejo = (slug: string, path: string): string => `${w(slug)}/forgejo/${path}`;
const qs = (params: Record<string, string | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&")}` : "";
};

function milestoneFromForgejo(m: ForgejoMilestoneRef): Milestone {
  return {
    id: m.id,
    title: m.title,
    description: m.description ?? "",
    state: m.state,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: m.due_on ? new Date(m.due_on).getTime() : null,
  };
}

function issueCommentFromForgejo(cm: ForgejoIssueCommentRaw): IssueComment {
  return {
    id: cm.id,
    body: cm.body,
    author_username: cm.user?.login ?? DELETED_USER_LOGIN,
    created_at: Date.parse(cm.created_at) || 0,
    updated_at: Date.parse(cm.updated_at) || 0,
  };
}

const DELETED_USER_LOGIN = "Ghost";

function prMetaFromForgejo(p: ForgejoPullRaw): PrMeta {
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    state: p.state === "closed" ? "closed" : "open",
    merged: p.merged ?? false,
    author_username: p.user?.login ?? DELETED_USER_LOGIN,
    created_at: Date.parse(p.created_at) || 0,
    merged_at: p.merged_at ? Date.parse(p.merged_at) : null,
    mergeable: p.mergeable ?? null,
    head_ref: p.head.ref,
    head_sha: p.head.sha,
    base_ref: p.base.ref,
    base_sha: p.base.sha,
    additions_total: p.additions ?? 0,
    deletions_total: p.deletions ?? 0,
    files_changed: p.changed_files ?? 0,
  };
}

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

  uploadAsset: async (slug: string, branch: string, file: File): Promise<{ path: string }> => {
    const form = new FormData();
    form.set("file", file);
    const res = await fetch(`${w(slug)}/assets${qs({ branch })}`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!res.ok) {
      let msg = `asset upload ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch (_err) {
        /* body wasn't JSON; keep the generic status message */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as { path: string };
  },

  suggest: (slug: string, params: { trigger: string; prefix: string; limit?: number }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${w(slug)}/suggest${qs({
        trigger: params.trigger,
        prefix: params.prefix,
        limit: params.limit?.toString(),
      })}`,
    ),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(`${w(slug)}/backlinks${qs({ id })}`).then((r) => r.backlinks),
  validateWorkspace: (slug: string) =>
    jsonFetch<WorkspaceValidation>(`${w(slug)}/validation`),
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
    jsonFetch<ForgejoPullRaw[]>(forgejo(slug, `pulls?state=${state}`)).then((rows) =>
      rows.map(prMetaFromForgejo),
    ),
  openPull: (
    slug: string,
    payload: { head: string; base?: string; title?: string; body?: string },
  ) =>
    jsonFetch<PrMeta>(`${w(slug)}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getPull: (slug: string, prNumber: number) =>
    jsonFetch<ForgejoPullRaw>(forgejo(slug, `pulls/${prNumber}`)).then(prMetaFromForgejo),
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

  listPrFiles: (slug: string, prNumber: number) =>
    jsonFetch<PrFiles>(`${w(slug)}/pulls/${prNumber}/files`),
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
  editComment: (slug: string, _prNumber: number, commentId: number, body: string) =>
    jsonFetch<unknown>(forgejo(slug, `issues/comments/${commentId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }).then(() => ({ ok: true as const })),
  deleteComment: (slug: string, prNumber: number, commentId: number, reviewId: number) =>
    jsonFetch<unknown>(
      forgejo(slug, `pulls/${prNumber}/reviews/${reviewId}/comments/${commentId}`),
      { method: "DELETE" },
    ).then(() => ({ ok: true as const })),

  startPendingReview: (slug: string, prNumber: number) =>
    jsonFetch<{ review_id: number }>(`${w(slug)}/pulls/${prNumber}/pending-review`, { method: "POST" }),
  addPendingReviewComment: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/pending-review/${reviewId}/comments`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  submitPendingReview: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { event: "approve" | "request_changes" | "comment"; body?: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/pending-review/${reviewId}/submit`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  // ---------- Workspace settings ----------

  getSettings: (slug: string) => jsonFetch<WorkspaceSettings>(`${w(slug)}/settings`),
  updateSettings: (slug: string, body: { min_approvals?: number; default_md_format?: DocumentFormatId }) =>
    jsonFetch<WorkspaceSettings>(`${w(slug)}/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

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
    jsonFetch<ForgejoIssueCommentRaw[]>(forgejo(slug, `issues/${number}/comments`)).then(
      (rows) => ({ comments: rows.map(issueCommentFromForgejo) }),
    ),
  createIssue: (slug: string, body: { title: string; body: string }) =>
    jsonFetch<{ number: number; title: string; state: "open" | "closed" }>(
      `${w(slug)}/issues`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  closeIssue: (slug: string, number: number) =>
    jsonFetch<{ state: "open" | "closed" }>(forgejo(slug, `issues/${number}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    }).then((issue) => ({ ok: true as const, state: issue.state as "closed" })),
  reopenIssue: (slug: string, number: number) =>
    jsonFetch<{ state: "open" | "closed" }>(forgejo(slug, `issues/${number}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    }).then((issue) => ({ ok: true as const, state: issue.state as "open" })),
  createIssueComment: (slug: string, number: number, body: string) =>
    jsonFetch<ForgejoIssueCommentRaw>(forgejo(slug, `issues/${number}/comments`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }).then(issueCommentFromForgejo),
  editIssueComment: (slug: string, _number: number, id: number, body: string) =>
    jsonFetch<ForgejoIssueCommentRaw>(forgejo(slug, `issues/comments/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }).then((cm) => ({ id: cm.id, body: cm.body, updated_at: Date.parse(cm.updated_at) || 0 })),
  deleteIssueComment: (slug: string, _number: number, id: number) =>
    jsonFetch<unknown>(forgejo(slug, `issues/comments/${id}`), { method: "DELETE" }).then(
      () => ({ ok: true as const }),
    ),
  renderForgejoMarkdown: async (slug: string, text: string): Promise<{ html: string }> => {
    const res = await fetch(forgejo(slug, "markdown"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Text: text, Mode: "comment", Wiki: false }),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? `HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const data = (await res.json()) as { html?: string };
      return { html: data.html ?? "" };
    }
    return { html: await res.text() };
  },
  listLabels: (slug: string) =>
    jsonFetch<Label[]>(forgejo(slug, "labels")).then((labels) => ({ labels })),
  createLabel: (slug: string, body: { name: string; color: string; description?: string }) =>
    jsonFetch<Label>(forgejo(slug, "labels"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, color: body.color.replace(/^#/, "") }),
    }),
  setIssueLabels: (slug: string, number: number, labels: number[]) =>
    jsonFetch<Label[]>(forgejo(slug, `issues/${number}/labels`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    }).then((labels) => ({ labels })),
  listPinnedIssues: (slug: string) =>
    jsonFetch<{ issues: IssueRow[] }>(`${w(slug)}/issues/pinned`),
  pinIssue: (slug: string, number: number) =>
    jsonFetch<void>(forgejo(slug, `issues/${number}/pin`), { method: "POST" }).then(() => ({ ok: true as const })),
  unpinIssue: (slug: string, number: number) =>
    jsonFetch<void>(forgejo(slug, `issues/${number}/pin`), { method: "DELETE" }).then(() => ({ ok: true as const })),
  getIssueTimeline: (slug: string, number: number) =>
    jsonFetch<{ events: TimelineEvent[] }>(`${w(slug)}/issues/${number}/timeline`),
  listActivities: (slug: string, limit = 50) =>
    jsonFetch<{ activities: ActivityRow[] }>(`${w(slug)}/activities?limit=${limit}`),
  listIssueDependencies: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/dependencies`),
  listIssueBlocks: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/blocks`),
  addIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).then(() => ({ ok: true as const })),
  removeIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/dependencies`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).then(() => ({ ok: true as const })),
  listMilestones: (slug: string, state: "open" | "closed" | "all" = "open") =>
    jsonFetch<ForgejoMilestoneRef[]>(forgejo(slug, `milestones?state=${state}`)).then((milestones) => ({
      milestones: milestones.map(milestoneFromForgejo),
    })),
  createMilestone: (slug: string, body: { title: string; description?: string }) =>
    jsonFetch<{ id: number; title: string; state: "open" | "closed" }>(forgejo(slug, "milestones"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  setIssueMilestone: (slug: string, number: number, id: number | null) =>
    jsonFetch<unknown>(forgejo(slug, `issues/${number}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestone: id ?? 0 }),
    }).then(() => ({ ok: true as const })),

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
export type { WorkspaceValidation };
