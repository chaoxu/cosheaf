import type {
  LocalAnnotation,
  LocalAnnotationKind,
  LocalAnnotationQueueItem,
  LocalAnnotationStatus,
} from "../../shared/local-annotations";
import type { WorkspaceValidation } from "../../shared/validation";
import { queryString, workspaceApiPath } from "../../shared/url";

interface PutFileResult {
  ok: true;
  branch: string;
  sha: string | null;
  content?: string;
}

interface OpenPullResult {
  number: number;
}

export type { LocalAnnotation, LocalAnnotationKind, LocalAnnotationQueueItem, LocalAnnotationStatus };

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
    jsonFetch<PutFileResult>(`${workspaceApiPath(owner, repo)}/file${queryString({ path, branch })}`, {
      method: "PUT",
      body: JSON.stringify(putFileBody(content, previousPath, expectedSha, expectedSourceSha, resetEditBranch)),
    }),

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

  suggest: (owner: string, repo: string, params: { trigger: string; prefix: string; branch?: string; limit?: number }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${workspaceApiPath(owner, repo)}/suggest${queryString({
        trigger: params.trigger,
        prefix: params.prefix,
        branch: params.branch,
        limit: params.limit,
      })}`,
    ),

  validation: (owner: string, repo: string) =>
    jsonFetch<WorkspaceValidation>(`${workspaceApiPath(owner, repo)}/validation`),

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
    jsonFetch<{ annotation: LocalAnnotation }>(`${workspaceApiPath(owner, repo)}/local-annotations`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateLocalAnnotation: (
    owner: string,
    repo: string,
    id: string,
    payload: { status?: LocalAnnotationStatus; path?: string },
  ) =>
    jsonFetch<{ annotation: LocalAnnotation }>(`${workspaceApiPath(owner, repo)}/local-annotations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  addLocalAnnotationMessage: (
    owner: string,
    repo: string,
    id: string,
    payload: { body: string },
  ) =>
    jsonFetch<{ annotation: LocalAnnotation }>(
      `${workspaceApiPath(owner, repo)}/local-annotations/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  deleteLocalAnnotation: (owner: string, repo: string, id: string) =>
    jsonFetch<{ ok: true }>(`${workspaceApiPath(owner, repo)}/local-annotations/${id}`, {
      method: "DELETE",
    }),

  openPull: (owner: string, repo: string, payload: { head: string; base?: string; title?: string; body?: string }) =>
    jsonFetch<OpenPullResult>(`${workspaceApiPath(owner, repo)}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  mergePull: (
    owner: string,
    repo: string,
    prNumber: number,
    opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
  ) =>
    jsonFetch<{ ok: true }>(`${workspaceApiPath(owner, repo)}/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: opts.Do ?? "squash", force: opts.force ?? false }),
    }),
};
