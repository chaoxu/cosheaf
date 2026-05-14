import type { ChangeState, Decision } from "../../shared/change-lifecycle";
import type { Role } from "../../shared/roles";
import type { ChangeDiff, PrMeta, PullFile } from "../../shared/review";
import type { LineComment, CommentSide } from "../../shared/comments";

export type { ChangeState, Decision, Role, ChangeDiff, PullFile, PrMeta, LineComment, CommentSide };

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

export interface Change {
  id: string;
  workspace_id: number;
  author_user_id: number;
  branch_name: string;
  state: ChangeState;
  pr_number: number | null;
  base_sha: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export interface QueueEntry {
  id: string;
  title: string;
  pr_number: number | null;
  author_user_id: number;
  created_at: number;
  approvals: number;
  rejections: number;
}

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
  change_id?: string;
  pr_number?: number;
  message?: string;
}

export interface DecisionResult {
  decision: Exclude<Decision, "comment">;
  change_id: string;
  state: ChangeState;
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

  tree: (slug: string, change_id?: string) =>
    jsonFetch<{ files: FileEntry[] }>(`${w(slug)}/tree${qs({ change_id })}`).then((r) => r.files),

  getFile: (slug: string, path: string, change_id?: string) =>
    jsonFetch<NoteContent>(`${w(slug)}/file${qs({ path, change_id })}`),
  putFile: (slug: string, path: string, content: string, change_id?: string) =>
    jsonFetch<{ ok: true; change_id: string; meta: DocumentMeta; content?: string; pending?: boolean }>(
      `${w(slug)}/file${qs({ path, change_id })}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  deleteFile: (slug: string, path: string, change_id?: string) =>
    jsonFetch<{ ok: true; change_id: string; pending: boolean }>(
      `${w(slug)}/file${qs({ path, change_id })}`,
      { method: "DELETE" },
    ),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(`${w(slug)}/backlinks${qs({ id })}`).then((r) => r.backlinks),
  search: (slug: string, q: string) =>
    jsonFetch<{ results: SearchResult[] }>(`${w(slug)}/search${qs({ q })}`).then((r) => r.results),

  // Changes
  listChanges: (slug: string) =>
    jsonFetch<{ changes: Change[] }>(`${w(slug)}/changes`).then((r) => r.changes),
  createChange: (slug: string, title?: string) =>
    jsonFetch<Change>(`${w(slug)}/change`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  discardChange: (slug: string, change_id: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/change/${encodeURIComponent(change_id)}`, { method: "DELETE" }),
  publish: (slug: string, change_id: string, mode?: "direct" | "review", title?: string) =>
    jsonFetch<PublishResult>(`${w(slug)}/publish`, {
      method: "POST",
      body: JSON.stringify({ change_id, mode, title }),
    }),
  approve: (slug: string, change_id: string, comment?: string) =>
    jsonFetch<DecisionResult>(`${w(slug)}/change/${encodeURIComponent(change_id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? null }),
    }),
  requestChanges: (slug: string, change_id: string, comment?: string) =>
    jsonFetch<DecisionResult>(`${w(slug)}/change/${encodeURIComponent(change_id)}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? null }),
    }),
  comment: (slug: string, change_id: string, comment?: string) =>
    jsonFetch<{ ok: true; change_id: string; state: Change["state"] }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/comment`,
      { method: "POST", body: JSON.stringify({ comment: comment ?? null }) },
    ),
  close: (slug: string, change_id: string) =>
    jsonFetch<{ ok: true; change_id: string; state: Change["state"] }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/close`,
      { method: "POST" },
    ),
  approvals: (slug: string, change_id: string) =>
    jsonFetch<{ approvals: ApprovalRecord[] }>(`${w(slug)}/change/${encodeURIComponent(change_id)}/approvals`).then((r) => r.approvals),

  queue: (slug: string) =>
    jsonFetch<{ queue: QueueEntry[] }>(`${w(slug)}/queue`).then((r) => r.queue),

  changePr: (slug: string, change_id: string) =>
    jsonFetch<{ pr: PrMeta }>(`${w(slug)}/change/${encodeURIComponent(change_id)}/pr`).then((r) => r.pr),
  changeDiff: (slug: string, change_id: string) =>
    jsonFetch<ChangeDiff>(`${w(slug)}/change/${encodeURIComponent(change_id)}/diff`),
  changeFile: (slug: string, change_id: string, path: string, side: "base" | "head") =>
    jsonFetch<{ content: string }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/file?path=${encodeURIComponent(path)}&side=${side}`,
    ).then((r) => r.content),
  changeComments: (slug: string, change_id: string) =>
    jsonFetch<{ comments: LineComment[] }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/comments`,
    ).then((r) => r.comments),
  addChangeComment: (
    slug: string,
    change_id: string,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/change/${encodeURIComponent(change_id)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  editChangeComment: (slug: string, change_id: string, commentId: number, body: string) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ),
  deleteChangeComment: (slug: string, change_id: string, commentId: number, reviewId: number) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/comments/${commentId}?review_id=${reviewId}`,
      { method: "DELETE" },
    ),
  startDraftReview: (slug: string, change_id: string) =>
    jsonFetch<{ review_id: number }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/draft-review`,
      { method: "POST" },
    ),
  addDraftReviewComment: (
    slug: string,
    change_id: string,
    review_id: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/draft-review/${review_id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  submitDraftReview: (
    slug: string,
    change_id: string,
    review_id: number,
    payload: { event: "approve" | "request_changes" | "comment"; body?: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/change/${encodeURIComponent(change_id)}/draft-review/${review_id}/submit`,
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
};
