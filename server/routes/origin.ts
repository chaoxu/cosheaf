import { Hono } from "hono";
import { allDocumentFormats } from "../format-registry.js";
import { WORKBENCH_COOKIE } from "../local/local-auth.js";
import { AUTH_COOKIE } from "../middleware.js";
import type { AppEnv } from "../types.js";

export const origin = new Hono<AppEnv>();

const documentFormats = () =>
  allDocumentFormats().map((format) => ({
    id: format.id,
    display_name: format.displayName,
    extensions: format.extensions,
  }));

// What a local Workbench actually serves. It owns local content (files, tree,
// branches, search over the working tree) but NOT collaboration: pull requests,
// issues, reviews, labels, milestones, and notifications live on a connected
// Cosheaf core (see `provider.collaboration: "federated"`). Opening a PR is a
// publish action federated to that core, not a capability the Workbench owns.
const localCapabilities = [
  { id: "repo_metadata", route_prefix: "/api/v1/repos/{owner}/{repo}" },
  { id: "files", route_prefix: "/api/v1/repos/{owner}/{repo}/contents" },
  { id: "branches", route_prefix: "/api/v1/repos/{owner}/{repo}/branches" },
  { id: "search", route_prefix: "/api/v1/repos/{owner}/{repo}/search" },
  { id: "publish_pull", route_prefix: "/api/v1/repos/{owner}/{repo}/pulls" },
  { id: "document_formats", route_prefix: "/api/v1/origin" },
] as const;

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
  const config = c.get("config");
  const serverUrl = config.publicOrigin ?? new URL(c.req.url).origin;

  // Local Workbench: a forge-free content provider. It owns local git content
  // and federates collaboration to a connected core, so its manifest advertises
  // the local capability set, its own auth model (the optional workbench access
  // token, or none on loopback), and a local-git source of truth — never the
  // hosted "Forgejo is authoritative" claim.
  if (config.mode === "local") {
    return c.json({
      origin_id: serverUrl,
      display_name: "Cosheaf Workbench",
      server_url: serverUrl,
      api_version: "v1",
      provider: { content: "local-git", collaboration: "federated" },
      auth_schemes: config.accessToken
        ? [
            {
              id: "cookie",
              type: "cookie",
              cookie_name: WORKBENCH_COOKIE,
              same_origin: true,
              description: "HttpOnly browser session cookie for the Workbench access token.",
            },
            {
              id: "bearer",
              type: "http",
              header: "Authorization",
              scheme: "Bearer",
              description: "The shared Workbench access token (COSHEAF_WORKBENCH_TOKEN) for typed API clients.",
            },
          ]
        : [{ id: "none", type: "none", description: "No authentication: loopback, single-user Workbench." }],
      capabilities: localCapabilities,
      document_formats: documentFormats(),
      consistency: {
        source_of_truth:
          "The local git working tree is authoritative for content; collaboration (pull requests, issues, reviews) is federated to a connected Cosheaf core, not owned here.",
        branch_reads: "File, tree, and branch routes read the local working tree and git directly.",
        main_index: "Search, backlinks, and xref metadata are derived from the local index and rebuilt on write.",
        events: "No notification stream in local mode; collaboration events live on the connected core.",
      },
    });
  }

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
    document_formats: documentFormats(),
    consistency: {
      source_of_truth: "Forgejo repository, pull request, issue, review, label, milestone, and notification state is authoritative.",
      branch_reads: "File, tree, branch, pull, and review routes read the requested Forgejo branch or pull state directly.",
      main_index: "Search, backlinks, diagnostics, and xref metadata are derived from the main branch sidecar and may lag until webhook or reindex reconciliation completes.",
      events: "SSE event streams are invalidation hints; clients should re-read typed resources after receiving an event.",
    },
  });
});
