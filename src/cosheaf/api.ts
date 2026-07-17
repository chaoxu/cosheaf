import type {
  LocalAnnotation,
  LocalAnnotationKind,
  LocalAnnotationQueueItem,
  LocalAnnotationStatus,
} from "../../shared/local-annotations";
import type {
  LocalAgentSession,
  LocalAgentSessionStatus,
} from "../../shared/local-agent-sessions";
import type { WorkspaceValidation } from "../../shared/validation";
import type { SuggestingHunk } from "../../shared/suggesting-diff";
import { queryString, workspaceApiPath } from "../../shared/url";

interface PutFileResult {
  ok: true;
  branch: string;
  sha: string | null;
  content?: string;
}

interface GetFileResult {
  content: string;
  sha: string | null;
  source_ref?: string;
  source_sha?: string | null;
}

interface OpenPullResult {
  number: number;
}

interface SuggestingBaseResult {
  path: string;
  base_text: string;
  head_sha: string;
  current_sha: string | null;
}

interface SuggestingRevertResult extends SuggestingBaseResult {
  content: string;
  sha: string | null;
  hunks: SuggestingHunk[];
}

interface SuggestingCheckpointResult extends SuggestingBaseResult {
  commit_sha: string | null;
}

export type { LocalAgentSession, LocalAgentSessionStatus, LocalAnnotation, LocalAnnotationKind, LocalAnnotationQueueItem, LocalAnnotationStatus };

interface ErrorBody {
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function putFileBody(
  content: string,
  previousPath?: string,
  expectedSha?: string | null,
  expectedSourceSha?: string,
  resetEditBranch?: boolean,
): Record<string, unknown> {
  return {
    content,
    ...(previousPath !== undefined ? { previous_path: previousPath } : {}),
    ...(expectedSha !== undefined ? { expected_sha: expectedSha } : {}),
    ...(expectedSourceSha !== undefined ? { expected_source_sha: expectedSourceSha } : {}),
    ...(resetEditBranch ? { reset_edit_branch: true } : {}),
  };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw await apiErrorFromResponse(res, `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return jsonFetch<T>(url, { method: "POST", body: JSON.stringify(body) });
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return jsonFetch<T>(url, { method: "PATCH", body: JSON.stringify(body) });
}

function put<T>(url: string, body: unknown): Promise<T> {
  return jsonFetch<T>(url, { method: "PUT", body: JSON.stringify(body) });
}

function del<T>(url: string): Promise<T> {
  return jsonFetch<T>(url, { method: "DELETE" });
}

async function apiErrorFromResponse(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  if (
    res.status === 401 &&
    (body.code === "pat_invalid" || body.code === "unauthorized") &&
    typeof window !== "undefined"
  ) {
    window.location.assign("/login");
  }
  return new ApiError(res.status, body.error ?? fallback, body.code, body.details);
}

export const api = {
  getFile: (
    owner: string,
    repo: string,
    path: string,
    branch: string,
  ) =>
    jsonFetch<GetFileResult>(`${workspaceApiPath(owner, repo)}/file${queryString({ path, branch })}`),

  putFile: (
    owner: string,
    repo: string,
    path: string,
    content: string,
    branch: string,
    previousPath?: string,
    expectedSha?: string | null,
    expectedSourceSha?: string,
    resetEditBranch?: boolean,
  ) =>
    put<PutFileResult>(
      `${workspaceApiPath(owner, repo)}/file${queryString({ path, branch })}`,
      putFileBody(content, previousPath, expectedSha, expectedSourceSha, resetEditBranch),
    ),

  uploadAsset: async (owner: string, repo: string, branch: string, file: File): Promise<{ path: string }> => {
    const form = new FormData();
    form.set("file", file);
    const res = await fetch(`${workspaceApiPath(owner, repo)}/assets${queryString({ branch })}`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!res.ok) {
      throw await apiErrorFromResponse(res, `asset upload ${res.status}`);
    }
    return (await res.json()) as { path: string };
  },

  suggest: (owner: string, repo: string, params: { trigger: string; prefix: string; branch?: string; limit?: number; path?: string }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${workspaceApiPath(owner, repo)}/suggest${queryString({
        trigger: params.trigger,
        prefix: params.prefix,
        branch: params.branch,
        limit: params.limit,
        path: params.path,
      })}`,
    ),

  validation: (owner: string, repo: string) =>
    jsonFetch<WorkspaceValidation>(`${workspaceApiPath(owner, repo)}/validation`),

  suggestingBase: (owner: string, repo: string, path: string) =>
    jsonFetch<SuggestingBaseResult>(
      `${workspaceApiPath(owner, repo)}/local-suggesting/base${queryString({ path })}`,
    ),

  revertSuggestingHunk: (
    owner: string,
    repo: string,
    path: string,
    hunk: SuggestingHunk,
    expected: { headSha: string; currentSha: string | null },
  ) =>
    post<SuggestingRevertResult>(`${workspaceApiPath(owner, repo)}/local-suggesting/revert`, {
      path,
      hunk,
      expected_head_sha: expected.headSha,
      expected_sha: expected.currentSha,
    }),

  checkpointSuggestingFile: (
    owner: string,
    repo: string,
    path: string,
    expected: { headSha: string; currentSha: string | null },
    message?: string,
  ) =>
    post<SuggestingCheckpointResult>(`${workspaceApiPath(owner, repo)}/local-suggesting/checkpoint`, {
      path,
      ...(message ? { message } : {}),
      expected_head_sha: expected.headSha,
      expected_sha: expected.currentSha,
    }),

  listLocalAnnotations: (
    owner: string,
    repo: string,
    params: { path?: string; status?: LocalAnnotationStatus } = {},
  ) =>
    jsonFetch<{ annotations: LocalAnnotation[] }>(
      `${workspaceApiPath(owner, repo)}/local-annotations${queryString(params)}`,
    ),

  listUnresolvedLocalAnnotations: (
    owner: string,
    repo: string,
    params: { path?: string } = {},
  ) =>
    jsonFetch<{ annotations: LocalAnnotationQueueItem[] }>(
      `${workspaceApiPath(owner, repo)}/local-annotations/unresolved${queryString(params)}`,
    ),

  createLocalAnnotation: (
    owner: string,
    repo: string,
    payload: { path: string; kind: LocalAnnotationKind; body: string },
  ) =>
    post<{ annotation: LocalAnnotation }>(`${workspaceApiPath(owner, repo)}/local-annotations`, payload),

  updateLocalAnnotation: (
    owner: string,
    repo: string,
    id: string,
    payload: { status?: LocalAnnotationStatus; path?: string },
  ) =>
    patch<{ annotation: LocalAnnotation }>(`${workspaceApiPath(owner, repo)}/local-annotations/${id}`, payload),

  addLocalAnnotationMessage: (
    owner: string,
    repo: string,
    id: string,
    payload: { body: string },
  ) =>
    post<{ annotation: LocalAnnotation }>(
      `${workspaceApiPath(owner, repo)}/local-annotations/${id}/messages`,
      payload,
    ),

  deleteLocalAnnotation: (owner: string, repo: string, id: string) =>
    del<{ ok: true }>(`${workspaceApiPath(owner, repo)}/local-annotations/${id}`),

  listLocalAgentSessions: (
    owner: string,
    repo: string,
    params: { status?: LocalAgentSessionStatus } = {},
  ) =>
    jsonFetch<{ sessions: LocalAgentSession[] }>(
      `${workspaceApiPath(owner, repo)}/agent-sessions${queryString(params)}`,
    ),

  createLocalAgentSession: (
    owner: string,
    repo: string,
    payload: { title?: string; touched_files?: string[]; linked_annotations?: string[]; summary?: string; message?: string },
  ) =>
    post<{ session: LocalAgentSession }>(`${workspaceApiPath(owner, repo)}/agent-sessions`, payload),

  updateLocalAgentSession: (
    owner: string,
    repo: string,
    id: string,
    payload: { status?: LocalAgentSessionStatus; title?: string; touched_files?: string[]; linked_annotations?: string[]; summary?: string; message?: string },
  ) =>
    patch<{ session: LocalAgentSession }>(`${workspaceApiPath(owner, repo)}/agent-sessions/${id}`, payload),

  completeLocalAgentSession: (
    owner: string,
    repo: string,
    id: string,
    payload: { summary?: string; message?: string } = {},
  ) =>
    post<{ session: LocalAgentSession }>(`${workspaceApiPath(owner, repo)}/agent-sessions/${id}/complete`, payload),

  openPull: (owner: string, repo: string, payload: { head: string; base?: string; title?: string; body?: string }) =>
    post<OpenPullResult>(`${workspaceApiPath(owner, repo)}/pulls`, payload),

  mergePull: (
    owner: string,
    repo: string,
    prNumber: number,
    opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
  ) =>
    post<{ ok: true }>(`${workspaceApiPath(owner, repo)}/pulls/${prNumber}/merge`, {
      Do: opts.Do ?? "squash",
      force: opts.force ?? false,
    }),
};
