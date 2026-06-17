interface PutFileResult {
  ok: true;
  branch: string;
  sha: string | null;
  content?: string;
}

interface OpenPullResult {
  number: number;
}

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

function workspaceApiPath(owner: string, repo: string): string {
  return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function queryString(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, value);
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export function putFileBody(content: string, previousPath?: string, expectedSha?: string | null, expectedSourceSha?: string): Record<string, unknown> {
  return {
    content,
    ...(previousPath !== undefined ? { previous_path: previousPath } : {}),
    ...(expectedSha !== undefined ? { expected_sha: expectedSha } : {}),
    ...(expectedSourceSha !== undefined ? { expected_source_sha: expectedSourceSha } : {}),
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
    const body = (await res.json().catch(() => ({}))) as ErrorBody;
    if (
      res.status === 401 &&
      (body.code === "pat_invalid" || body.code === "unauthorized") &&
      typeof window !== "undefined"
    ) {
      window.location.assign("/login");
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code, body.details);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
  ) =>
    jsonFetch<PutFileResult>(`${workspaceApiPath(owner, repo)}/file${queryString({ path, branch })}`, {
      method: "PUT",
      body: JSON.stringify(putFileBody(content, previousPath, expectedSha, expectedSourceSha)),
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
      let msg = `asset upload ${res.status}`;
      let code: string | undefined;
      let details: Record<string, unknown> | undefined;
      try {
        const data = (await res.json()) as ErrorBody;
        if (data.error) msg = data.error;
        code = data.code;
        details = data.details;
      } catch (_err) {
        /* body was not JSON; keep the status message */
      }
      throw new ApiError(res.status, msg, code, details);
    }
    return (await res.json()) as { path: string };
  },

  suggest: (owner: string, repo: string, params: { trigger: string; prefix: string; limit?: number }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${workspaceApiPath(owner, repo)}/suggest${queryString({
        trigger: params.trigger,
        prefix: params.prefix,
        limit: params.limit?.toString(),
      })}`,
    ),

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
