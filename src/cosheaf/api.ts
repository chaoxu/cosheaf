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

export interface DocumentMeta {
  id: string;
  type: "page" | "review" | "proposal" | "task";
  status: "golden" | "unreviewed" | "rejected" | "draft" | "archived";
  title: string | null;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  doc?: DocumentMeta;
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
    jsonFetch<{ ok: true; mtime: number; meta: DocumentMeta; content?: string }>(
      `/api/w/${encodeURIComponent(slug)}/note?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: JSON.stringify({ content, expected_mtime }) },
    ),
  deleteNote: (slug: string, path: string) =>
    jsonFetch<{ ok: true }>(
      `/api/w/${encodeURIComponent(slug)}/note?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(
      `/api/w/${encodeURIComponent(slug)}/backlinks?id=${encodeURIComponent(id)}`,
    ).then((r) => r.backlinks),

  search: (slug: string, q: string) =>
    jsonFetch<{ results: SearchResult[] }>(
      `/api/w/${encodeURIComponent(slug)}/search?q=${encodeURIComponent(q)}`,
    ).then((r) => r.results),

  listTokens: () =>
    jsonFetch<{ tokens: TokenInfo[] }>("/api/tokens").then((r) => r.tokens),
  createToken: (name: string) =>
    jsonFetch<{ id: number; name: string; token: string }>("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  revokeToken: (id: number) =>
    jsonFetch<{ ok: true }>(`/api/tokens/${id}`, { method: "DELETE" }),
};

export interface TokenInfo {
  id: number;
  name: string;
  created_at: number;
}

export interface SearchResult {
  doc_id: string;
  path: string;
  title: string | null;
  snippet: string;
  rank: number;
}

export interface Backlink {
  src_id: string;
  src_path: string;
  src_title: string | null;
  target_label: string;
}
