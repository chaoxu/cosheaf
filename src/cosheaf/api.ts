export interface User {
  id: number;
  username: string;
}

export interface Workspace {
  id: number;
  slug: string;
  name: string;
  role: "owner" | "verifier" | "member";
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface NoteContent {
  content: string;
  mtime: number;
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

export const api = {
  me: () => jsonFetch<{ user: User | null }>("/api/me"),
  login: (username: string, password: string) =>
    jsonFetch<User>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => jsonFetch<{ ok: true }>("/api/logout", { method: "POST" }),

  listWorkspaces: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces").then((r) => r.workspaces),
  createWorkspace: (slug: string, name: string) =>
    jsonFetch<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ slug, name }),
    }),

  tree: (slug: string) =>
    jsonFetch<{ files: FileEntry[] }>(`/api/w/${encodeURIComponent(slug)}/tree`).then((r) => r.files),
  getNote: (slug: string, path: string) =>
    jsonFetch<NoteContent>(
      `/api/w/${encodeURIComponent(slug)}/note?path=${encodeURIComponent(path)}`,
    ),
  putNote: (slug: string, path: string, content: string, expected_mtime?: number) =>
    jsonFetch<{ ok: true; mtime: number }>(
      `/api/w/${encodeURIComponent(slug)}/note?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: JSON.stringify({ content, expected_mtime }) },
    ),
};
