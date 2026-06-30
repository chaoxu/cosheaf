import { Hono } from "hono";
import { allDocumentFormats } from "../format-registry.js";
import { AUTH_COOKIE } from "../middleware.js";
import type { AppEnv } from "../types.js";

export const origin = new Hono<AppEnv>();

const capabilities = [
  { id: "auth", route_prefix: "/api/v1" },
  { id: "workspaces", route_prefix: "/api/v1/workspaces" },
  { id: "repo_metadata", route_prefix: "/api/v1/repos/{owner}/{repo}" },
  { id: "files", route_prefix: "/api/v1/repos/{owner}/{repo}/contents" },
  { id: "branches", route_prefix: "/api/v1/repos/{owner}/{repo}/branches" },
  { id: "pulls", route_prefix: "/api/v1/repos/{owner}/{repo}/pulls" },
  { id: "reviews", route_prefix: "/api/v1/repos/{owner}/{repo}/pulls/{number}/reviews" },
  { id: "issues", route_prefix: "/api/v1/repos/{owner}/{repo}/issues" },
  { id: "labels", route_prefix: "/api/v1/repos/{owner}/{repo}/labels" },
  { id: "milestones", route_prefix: "/api/v1/repos/{owner}/{repo}/milestones" },
  { id: "notifications", route_prefix: "/api/v1/notifications" },
  { id: "events", route_prefix: "/api/v1/repos/{owner}/{repo}/events" },
  { id: "search", route_prefix: "/api/v1/repos/{owner}/{repo}/search" },
  { id: "diagnostics", route_prefix: "/{owner}/{repo}/diagnostics" },
  { id: "document_formats", route_prefix: "/api/v1/origin" },
] as const;

origin.get("/origin", (c) => {
  const serverUrl = c.get("config").publicOrigin ?? new URL(c.req.url).origin;
  return c.json({
    origin_id: serverUrl,
    display_name: "Cosheaf",
    server_url: serverUrl,
    api_version: "v1",
    auth_schemes: [
      {
        id: "cookie",
        type: "cookie",
        cookie_name: AUTH_COOKIE,
        same_origin: true,
        description: "HttpOnly browser session cookie for same-origin web pages.",
      },
      {
        id: "bearer",
        type: "http",
        header: "Authorization",
        scheme: "Bearer",
        description: "Opaque Cosheaf API token for typed API clients.",
      },
      {
        id: "token",
        type: "http",
        header: "Authorization",
        scheme: "token",
        description: "Tea/Gitea-compatible spelling for the same opaque Cosheaf API token.",
      },
    ],
    capabilities,
    document_formats: allDocumentFormats().map((format) => ({
      id: format.id,
      display_name: format.displayName,
      extensions: format.extensions,
    })),
    consistency: {
      source_of_truth: "Forgejo repository, pull request, issue, review, label, milestone, and notification state is authoritative.",
      branch_reads: "File, tree, branch, pull, and review routes read the requested Forgejo branch or pull state directly.",
      main_index: "Search, backlinks, diagnostics, and xref metadata are derived from the main branch sidecar and may lag until webhook or reindex reconciliation completes.",
      events: "SSE event streams are invalidation hints; clients should re-read typed resources after receiving an event.",
    },
  });
});
