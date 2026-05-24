interface PutFileResult {
  ok: true;
  branch: string;
  content?: string;
}

interface OpenPullResult {
  number: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function workspaceApiPath(slug: string): string {
  return `/api/v1/w/${encodeURIComponent(slug)}`;
}

function queryString(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, value);
  }
  const text = q.toString();
  return text ? `?${text}` : "";
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (
      res.status === 401 &&
      (body.code === "pat_invalid" || body.code === "unauthorized") &&
      typeof window !== "undefined"
    ) {
      window.location.assign("/login");
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  putFile: (slug: string, path: string, content: string, branch: string, previousPath?: string) =>
    jsonFetch<PutFileResult>(`${workspaceApiPath(slug)}/file${queryString({ path, branch })}`, {
      method: "PUT",
      body: JSON.stringify({ content, previous_path: previousPath }),
    }),

  uploadAsset: async (slug: string, branch: string, file: File): Promise<{ path: string }> => {
    const form = new FormData();
    form.set("file", file);
    const res = await fetch(`${workspaceApiPath(slug)}/assets${queryString({ branch })}`, {
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
        /* body was not JSON; keep the status message */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as { path: string };
  },

  suggest: (slug: string, params: { trigger: string; prefix: string; limit?: number }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${workspaceApiPath(slug)}/suggest${queryString({
        trigger: params.trigger,
        prefix: params.prefix,
        limit: params.limit?.toString(),
      })}`,
    ),

  openPull: (slug: string, payload: { head: string; base?: string; title?: string; body?: string }) =>
    jsonFetch<OpenPullResult>(`${workspaceApiPath(slug)}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  mergePull: (
    slug: string,
    prNumber: number,
    opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
  ) =>
    jsonFetch<{ ok: true }>(`${workspaceApiPath(slug)}/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: opts.Do ?? "squash", force: opts.force ?? false }),
    }),
};
