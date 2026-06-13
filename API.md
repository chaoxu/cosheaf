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
  owner: string;
  repo: string;
  full_name: string;   // "owner/repo" — the canonical workspace slug
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
revoke it in the backing forge to invalidate it across devices. Cosheaf keeps
one cached Forgejo PAT per username so repeated logins do not create a new
Forgejo token every time; each login still validates the password with Forgejo
before returning the cached PAT.

There is no Cosheaf personal-token API yet. Create and revoke tokens in the
backing forge.

## Workspaces

A workspace is a Forgejo `(owner, repo)` pair; the canonical workspace slug is
the full `owner/repo` string. All typed workspace routes live under
`/repos/:owner/:repo/*`.

```http
GET /workspaces
→ { "workspaces": Workspace[] }     # all owners the caller can see

POST /workspaces
{ "owner"?: string, "slug": string, "name": string, "default_md_format"?: "forgejo-passthrough" | "coflat" }
→ 201 Workspace
# owner defaults to the caller; slug is the repo name under that owner

PUT /repos/:owner/:repo/members/:username
{ "role": "admin" | "write" | "read" }
→ { "ok": true, "username": string, "role": "admin" | "write" | "read" }
```

Creating a workspace runs on the caller's own PAT and provisions a Forgejo
repository, branch protection, webhook, `.gitattributes`, and the initial
sidecar index.
Setting workspace members requires workspace admin access. Cosheaf applies the
role to the underlying repository and keeps the main-branch direct-push
whitelist in sync for admin users.

## Files

Workspace routes require membership. File reads and writes use typed routes
when callers need Cosheaf document behavior: path validation, Coflat
frontmatter/id handling, branch naming, synchronous reindexing, backlinks/FTS,
and SSE updates.

```http
GET /repos/:owner/:repo/tree?branch=<branch>
→ { "files": FileEntry[] }

GET /repos/:owner/:repo/file?path=<path>&branch=<branch>
→ { "content": string }

PUT /repos/:owner/:repo/file?path=<path>&branch=<branch>
{ "content": string }
→ { "ok": true, "branch": string, "meta": DocumentMeta, "content"?: string, "commit"?: string }

DELETE /repos/:owner/:repo/file?path=<path>&branch=<branch>
→ { "ok": true, "branch": string }
```

A Markdown write made outside Cosheaf is treated as an external repository
edit. It reaches SQLite through webhook or `pnpm cli workspace reindex
<owner>/<repo>` reconciliation, not through immediate typed file-route
indexing.

## Search, Backlinks, Suggestions

```http
GET /repos/:owner/:repo/search?q=<query>
→ { "results": SearchResult[] }

GET /repos/:owner/:repo/backlinks?id=<doc_id>
→ { "backlinks": Backlink[] }

GET /repos/:owner/:repo/suggest?trigger=<trigger>&prefix=<prefix>&limit=<n>
→ { "suggestions": Array<{ id: string, insert: string, display: string }> }

GET /repos/:owner/:repo/validation
→ WorkspaceValidation     # broken-reference report consumed by the linter tab

GET /repos/:owner/:repo/activities?limit=<n>
→ { "activities": ActivityRow[] }   # normalized over the backend activity feed
                                    # JSON (which encodes refs in opaque strings)
```

`snippet` values in search results are structured plain text. Render segments
with `match: true` as highlighted text; clients should not treat snippets as
HTML. Indexed links are `[@id]` and `[text](relative.md[#fragment])`.

## Branches

```http
GET /repos/:owner/:repo/branches/mine
→ { "branches": Branch[] }

POST /repos/:owner/:repo/branches
{ "name": string }
→ { "name": string }

DELETE /repos/:owner/:repo/branches/:name
→ { "ok": true }
```

`branches/mine` lists the caller's in-progress branches that do not have an
open pull request. Branches and pull requests live in the backing forge;
SQLite does not mirror them.

## Pull Requests

```http
POST /repos/:owner/:repo/pulls
{ "head": string, "base"?: string, "title"?: string, "body"?: string }
→ PrMeta

GET /repos/:owner/:repo/pulls?state=open|closed|all&labels=<id>&milestone=<id>&author=<username>&sort=<sort>
→ { "pulls": PrMeta[] }

GET /repos/:owner/:repo/pulls/:n
→ { "pull": PrMeta }

PATCH /repos/:owner/:repo/pulls/:n
{ "title"?: string, "body"?: string }
→ { "pull": PrMeta }

PUT /repos/:owner/:repo/pulls/:n/labels
{ "labels": number[] }
→ { "pull": PrMeta }

POST /repos/:owner/:repo/pulls/:n/merge
{ "Do"?: "squash" | "merge" | "rebase", "force"?: boolean }
→ { "ok": true }

POST /repos/:owner/:repo/pulls/:n/close
→ { "ok": true }
```

Cosheaf returns `PrMeta`: `number`, `title`, `body`, `state`, `merged`,
author, head/base refs and SHAs, timestamps, mergeability, changed-file counts,
labels, milestone, and requested reviewers.

## Pull Request Reviews And Comments

```http
GET /repos/:owner/:repo/pulls/:n/files
→ { "files": PullFile[] }

GET /repos/:owner/:repo/pulls/:n/file?path=<path>&side=base|head
→ { "content": string }

POST /repos/:owner/:repo/pulls/:n/reviews
{ "event": "APPROVE" | "REQUEST_CHANGES" | "COMMENT", "body"?: string | null }
→ { "ok": true, "approvals": number, "rejections": number }

GET /repos/:owner/:repo/pulls/:n/reviews
→ { "reviews": ApprovalRecord[], "approvals": number, "rejections": number }

GET /repos/:owner/:repo/pulls/:n/review-requests
→ { "requested_reviewers": string[], "requested_reviewer_teams": string[], "available_reviewers": string[] }

POST /repos/:owner/:repo/pulls/:n/review-requests
{ "reviewers": string[] }
→ { "pull": PrMeta }

DELETE /repos/:owner/:repo/pulls/:n/review-requests
{ "reviewers": string[] }
→ { "pull": PrMeta | null }

GET /repos/:owner/:repo/pulls/:n/comments
→ { "comments": LineComment[] }

POST /repos/:owner/:repo/pulls/:n/comments
{ "path": string, "line": number, "side": "base" | "head", "body": string }
→ { "ok": true }

PATCH /repos/:owner/:repo/pulls/:n/comments/:commentId
{ "body": string }
→ { "ok": true }

DELETE /repos/:owner/:repo/pulls/:n/comments/:commentId?review_id=<reviewId>
→ { "ok": true }
```

Pending review helpers exist because the backend represents pending reviews
separately:

```http
POST /repos/:owner/:repo/pulls/:n/pending-review
→ { "review_id": number }

POST /repos/:owner/:repo/pulls/:n/pending-review/:reviewId/comments
{ "path": string, "line": number, "side": "base" | "head", "body": string }
→ { "ok": true }

POST /repos/:owner/:repo/pulls/:n/pending-review/:reviewId/submit
{ "event": "approve" | "request_changes" | "comment", "body"?: string }
→ { "ok": true }
```

## Issues

Issue routes return normalized Cosheaf DTOs and are the public surface for
issue automation.

```http
GET /repos/:owner/:repo/issues?state=open|closed|all&filter=mine|assigned|all&q=<query>&labels=<name>&milestones=<id-or-name>&created_by=<username>&assigned_by=<username>&sort=<sort>
→ { "issues": IssueRow[] }

GET /repos/:owner/:repo/issues/pinned
→ { "issues": IssueRow[] }

GET /repos/:owner/:repo/issues/:n
→ IssueDetail

PATCH /repos/:owner/:repo/issues/:n
{ "title"?: string, "body"?: string }
→ { "number": number, "title": string, "body": string, "state": "open" | "closed" }

POST /repos/:owner/:repo/issues
{ "title": string, "body": string }
→ { "number": number, "title": string, "state": "open" | "closed" }

PATCH /repos/:owner/:repo/issues/:n/state
{ "state": "open" | "closed" }
→ { "ok": true, "state": "open" | "closed" }

GET /repos/:owner/:repo/issues/:n/comments
→ { "comments": IssueComment[] }

POST /repos/:owner/:repo/issues/:n/comments
{ "body": string }
→ IssueComment

PATCH /repos/:owner/:repo/issues/:n/comments/:commentId
{ "body": string }
→ IssueComment

DELETE /repos/:owner/:repo/issues/:n/comments/:commentId
→ { "ok": true }

GET /repos/:owner/:repo/issues/:n/timeline
→ { "events": TimelineEvent[] }

GET /repos/:owner/:repo/issues/:n/dependencies
→ { "issues": DependencyRow[] }

POST /repos/:owner/:repo/issues/:n/dependencies
{ "index": number }
→ { "issue": DependencyRow }

DELETE /repos/:owner/:repo/issues/:n/dependencies
{ "index": number }
→ { "issue": DependencyRow }

GET /repos/:owner/:repo/issues/:n/blocks
→ { "issues": DependencyRow[] }
```

```http
GET /repos/:owner/:repo/labels
→ { "labels": Label[] }

POST /repos/:owner/:repo/labels
{ "name": string, "color": string, "description"?: string, "exclusive"?: boolean }
→ Label

PUT /repos/:owner/:repo/issues/:n/labels
{ "labels": number[] }
→ { "labels": Label[] }

POST /repos/:owner/:repo/issues/:n/pin
→ { "ok": true }

DELETE /repos/:owner/:repo/issues/:n/pin
→ { "ok": true }

GET /repos/:owner/:repo/milestones?state=open|closed|all
→ { "milestones": Milestone[] }

POST /repos/:owner/:repo/milestones
{ "title": string, "description"?: string }
→ Milestone

PATCH /repos/:owner/:repo/issues/:n/milestone
{ "id": number | null }
→ { "ok": true }

POST /repos/:owner/:repo/markdown/render
{ "text": string }
→ { "html": string }
```

## Notifications

```http
GET /repos/:owner/:repo/notifications
→ { "notifications": NotificationRow[] }

POST /repos/:owner/:repo/notifications/:id/read
→ { "ok": true }

POST /repos/:owner/:repo/notifications/read-all
→ { "ok": true }
```

## Settings

```http
GET /repos/:owner/:repo/settings
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }

PUT /repos/:owner/:repo/settings
{ "min_approvals"?: number, "default_md_format"?: "forgejo-passthrough" | "coflat" }
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }
```

Approval settings map to backend branch protection on `main`. The workspace
markdown format controls typed file indexing and server-rendered page output. Updating
settings requires admin permission.

## Events

```http
GET /repos/:owner/:repo/events
```

Server-sent events stream JSON messages for file changes/removals, pull
request updates, reviews, issue updates, and issue comments. Events are
workspace-scoped hints; the backing forge and the typed read routes remain the
source of truth after reconnect.
