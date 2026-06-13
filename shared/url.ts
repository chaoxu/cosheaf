// Percent-encode each path segment while preserving the slashes between them.
// Used to build repo/file URLs from owner/repo/branch/path components without
// escaping the separators. Shared by the server web routes and the browser
// islands.
export function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
