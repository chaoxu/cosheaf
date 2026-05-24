# Cosheaf API

This document is the human-facing contract for the current HTTP API. The
implementation source of truth remains `server/routes/*.ts` and the shared
DTO types under `shared/`.

Base path: `/api/v1`

All JSON routes return `{ error, code }` on expected failures. API requests
authenticate via `Authorization: Bearer <token>`. Server-rendered web pages
authenticate with the same PAT in an HttpOnly `cosheaf_pat` cookie. Cosheaf
validates the token, resolves workspace membership, and forwards the caller
identity on backend-backed operations.

## Core Types

```ts
type Role = "admin" | "write" | "read";

interface User {
  username: string;
}

interface Workspace {
  slug: string;
  name: string;
  role: Role;
  default_md_format: "forgejo-passthrough" | "coflat";
}

interface DocumentMeta {
  id: string;
  title: string | null;
}

interface FileEntry {
  path: string;
  size: number;
  doc?: DocumentMeta;
}

interface Branch {
  name: string;
  commit_sha: string | null;
  updated_at: number;
}
```

## Errors

Every typed route returns errors as `{ error, code, details? }` with an HTTP
status that matches the `code`. Agents should switch on `code` rather than
parsing `error`. The `details` field carries structured context for
multi-step failures (e.g. `step: "reindex"` on settings updates).

```ts
type ErrorCode =
  | "validation"        // 400 — caller payload is malformed or missing fields
  | "unauthorized"      // 401 — no session / bearer token
  | "pat_invalid"       // 401 — backend rejected the stored token; client should re-authenticate
  | "forbidden"         // 403 — authenticated but lacks the required role
  | "not_found"         // 404
  | "conflict"          // 409 — backend precondition (merge conflict, dup PR)
  | "backend_failed"    // 502 — backend write rejected; carries details.step
  | "reindex_failed"    // 502 — backend updated but sidecar didn't; retry-safe
  | "bad_gateway";      // 502 — backend upstream unreachable / 5xx
```

## Auth

Cosheaf owns the login UX so users do not need to know which forge is the
backend. Login exchanges username/password credentials for a fresh API token
and sets it as an HttpOnly cookie for server-rendered browser pages. The JSON
response still includes the token for API clients that explicitly call the
login route; external clients can also skip login and send their own Cosheaf
API token directly.

```http
POST /login
{ "username": string, "password": string }
→ { "username": string, "pat": string }

POST /logout
→ { "ok": true }

GET /me
→ { "user": { "username": string } | null }
```

Logout clears the browser cookie. Cosheaf does not revoke the token on logout;
revoke it in the backing forge to invalidate it across devices.

There is no Cosheaf personal-token API yet. Create and revoke tokens in the
backing forge.

## Workspaces

```http
GET /workspaces
→ { "workspaces": Workspace[] }

POST /workspaces
{ "slug": string, "name": string, "default_md_format"?: "forgejo-passthrough" | "coflat" }
→ 201 Workspace

PUT /workspaces/:slug/members/:username
{ "role": "admin" | "write" | "read" }
→ { "ok": true, "username": string, "role": "admin" | "write" | "read" }
```

Creating a workspace provisions a Forgejo repository, branch protection,
webhook, `.gitattributes`, and the initial sidecar index.
Setting workspace members requires workspace admin access. Cosheaf applies the
role to the underlying repository and keeps the main-branch direct-push
whitelist in sync for admin users.

## Files

Workspace routes require membership. File reads and writes use typed routes
when callers need Cosheaf document behavior: path validation, Coflat
frontmatter/id handling, branch naming, synchronous reindexing, backlinks/FTS,
and SSE updates.

```http
GET /w/:slug/tree?branch=<branch>
→ { "files": FileEntry[] }

GET /w/:slug/file?path=<path>&branch=<branch>
→ { "content": string }

PUT /w/:slug/file?path=<path>&branch=<branch>
{ "content": string }
→ { "ok": true, "branch": string, "meta": DocumentMeta, "content"?: string, "commit"?: string }

DELETE /w/:slug/file?path=<path>&branch=<branch>
→ { "ok": true, "branch": string }
```

A Markdown write made outside Cosheaf is treated as an external repository
edit. It reaches SQLite through webhook or `pnpm cli workspace reindex <slug>`
reconciliation, not through immediate typed file-route indexing.

## Search, Backlinks, Suggestions

```http
GET /w/:slug/search?q=<query>
→ { "results": SearchResult[] }

GET /w/:slug/backlinks?id=<doc_id>
→ { "backlinks": Backlink[] }

GET /w/:slug/suggest?trigger=<trigger>&prefix=<prefix>&limit=<n>
→ { "suggestions": Array<{ id: string, insert: string, display: string }> }

GET /w/:slug/validation
→ WorkspaceValidation     # broken-reference report consumed by the linter tab

GET /w/:slug/activities?limit=<n>
→ { "activities": ActivityRow[] }   # normalized over the backend activity feed
                                    # JSON (which encodes refs in opaque strings)
```

`snippet` values in search results are structured plain text. Render segments
with `match: true` as highlighted text; clients should not treat snippets as
HTML. Indexed links are `[@id]` and `[text](relative.md[#fragment])`.

## Branches

```http
GET /w/:slug/branches/mine
→ { "branches": Branch[] }

POST /w/:slug/branches
{ "name": string }
→ { "name": string }

DELETE /w/:slug/branches/:name
→ { "ok": true }
```

`branches/mine` lists the caller's in-progress branches that do not have an
open pull request. Branches and pull requests live in the backing forge;
SQLite does not mirror them.

## Pull Requests

```http
POST /w/:slug/pulls
{ "head": string, "base"?: string, "title"?: string, "body"?: string }
→ PrMeta

GET /w/:slug/pulls?state=open|closed|all&labels=<id>&milestone=<id>&author=<username>&sort=<sort>
→ { "pulls": PrMeta[] }

GET /w/:slug/pulls/:n
→ { "pull": PrMeta }

PATCH /w/:slug/pulls/:n
{ "title"?: string, "body"?: string }
→ { "pull": PrMeta }

PUT /w/:slug/pulls/:n/labels
{ "labels": number[] }
→ { "pull": PrMeta }

POST /w/:slug/pulls/:n/merge
{ "Do"?: "squash" | "merge" | "rebase", "force"?: boolean }
→ { "ok": true }

POST /w/:slug/pulls/:n/close
→ { "ok": true }
```

Cosheaf returns `PrMeta`: `number`, `title`, `body`, `state`, `merged`,
author, head/base refs and SHAs, timestamps, mergeability, changed-file counts,
labels, milestone, and requested reviewers.

## Pull Request Reviews And Comments

```http
GET /w/:slug/pulls/:n/files
→ { "files": PullFile[] }

GET /w/:slug/pulls/:n/file?path=<path>&side=base|head
→ { "content": string }

POST /w/:slug/pulls/:n/reviews
{ "event": "APPROVE" | "REQUEST_CHANGES" | "COMMENT", "body"?: string | null }
→ { "ok": true, "approvals": number, "rejections": number }

GET /w/:slug/pulls/:n/reviews
→ { "reviews": ApprovalRecord[], "approvals": number, "rejections": number }

GET /w/:slug/pulls/:n/review-requests
→ { "requested_reviewers": string[], "requested_reviewer_teams": string[], "available_reviewers": string[] }

POST /w/:slug/pulls/:n/review-requests
{ "reviewers": string[] }
→ { "pull": PrMeta }

DELETE /w/:slug/pulls/:n/review-requests
{ "reviewers": string[] }
→ { "pull": PrMeta | null }

GET /w/:slug/pulls/:n/comments
→ { "comments": LineComment[] }

POST /w/:slug/pulls/:n/comments
{ "path": string, "line": number, "side": "base" | "head", "body": string }
→ { "ok": true }

PATCH /w/:slug/pulls/:n/comments/:commentId
{ "body": string }
→ { "ok": true }

DELETE /w/:slug/pulls/:n/comments/:commentId?review_id=<reviewId>
→ { "ok": true }
```

Pending review helpers exist because the backend represents pending reviews
separately:

```http
POST /w/:slug/pulls/:n/pending-review
→ { "review_id": number }

POST /w/:slug/pulls/:n/pending-review/:reviewId/comments
{ "path": string, "line": number, "side": "base" | "head", "body": string }
→ { "ok": true }

POST /w/:slug/pulls/:n/pending-review/:reviewId/submit
{ "event": "approve" | "request_changes" | "comment", "body"?: string }
→ { "ok": true }
```

## Issues

Issue routes return normalized Cosheaf DTOs and are the public surface for
issue automation.

```http
GET /w/:slug/issues?state=open|closed|all&filter=mine|assigned|all&q=<query>&labels=<name>&milestones=<id-or-name>&created_by=<username>&assigned_by=<username>&sort=<sort>
→ { "issues": IssueRow[] }

GET /w/:slug/issues/pinned
→ { "issues": IssueRow[] }

GET /w/:slug/issues/:n
→ IssueDetail

PATCH /w/:slug/issues/:n
{ "title"?: string, "body"?: string }
→ { "number": number, "title": string, "body": string, "state": "open" | "closed" }

POST /w/:slug/issues
{ "title": string, "body": string }
→ { "number": number, "title": string, "state": "open" | "closed" }

PATCH /w/:slug/issues/:n/state
{ "state": "open" | "closed" }
→ { "ok": true, "state": "open" | "closed" }

GET /w/:slug/issues/:n/comments
→ { "comments": IssueComment[] }

POST /w/:slug/issues/:n/comments
{ "body": string }
→ IssueComment

PATCH /w/:slug/issues/:n/comments/:commentId
{ "body": string }
→ IssueComment

DELETE /w/:slug/issues/:n/comments/:commentId
→ { "ok": true }

GET /w/:slug/issues/:n/timeline
→ { "events": TimelineEvent[] }

GET /w/:slug/issues/:n/dependencies
→ { "issues": DependencyRow[] }

POST /w/:slug/issues/:n/dependencies
{ "index": number }
→ { "issue": DependencyRow }

DELETE /w/:slug/issues/:n/dependencies
{ "index": number }
→ { "issue": DependencyRow }

GET /w/:slug/issues/:n/blocks
→ { "issues": DependencyRow[] }
```

```http
GET /w/:slug/labels
→ { "labels": Label[] }

POST /w/:slug/labels
{ "name": string, "color": string, "description"?: string, "exclusive"?: boolean }
→ Label

PUT /w/:slug/issues/:n/labels
{ "labels": number[] }
→ { "labels": Label[] }

POST /w/:slug/issues/:n/pin
→ { "ok": true }

DELETE /w/:slug/issues/:n/pin
→ { "ok": true }

GET /w/:slug/milestones?state=open|closed|all
→ { "milestones": Milestone[] }

POST /w/:slug/milestones
{ "title": string, "description"?: string }
→ Milestone

PATCH /w/:slug/issues/:n/milestone
{ "id": number | null }
→ { "ok": true }

POST /w/:slug/markdown/render
{ "text": string }
→ { "html": string }
```

## Notifications

```http
GET /w/:slug/notifications
→ { "notifications": NotificationRow[] }

POST /w/:slug/notifications/:id/read
→ { "ok": true }

POST /w/:slug/notifications/read-all
→ { "ok": true }
```

## Settings

```http
GET /w/:slug/settings
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }

PUT /w/:slug/settings
{ "min_approvals"?: number, "default_md_format"?: "forgejo-passthrough" | "coflat" }
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }
```

Approval settings map to backend branch protection on `main`. The workspace
markdown format controls typed file indexing and server-rendered page output. Updating
settings requires admin permission.

## Events

```http
GET /w/:slug/events
```

Server-sent events stream JSON messages for file changes/removals, pull
request updates, reviews, issue updates, and issue comments. Events are
workspace-scoped hints; the backing forge and the typed read routes remain the
source of truth after reconnect.
