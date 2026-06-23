// Percent-encode each path segment while preserving the slashes between them.
// Used to build repo/file URLs from owner/repo/branch/path components without
// escaping the separators. Shared by the server web routes and the browser
// islands.
export function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function repoHref(owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function userHref(login: string): string {
  return `/users/${encodeURIComponent(login)}`;
}

export function repoBranchFileHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

export function rawRepoBranchFileHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/raw/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

export function workspaceApiPath(owner: string, repo: string): string {
  return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}
