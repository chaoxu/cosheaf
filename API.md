# Cosheaf API

This document is the human-facing contract for the current HTTP API. The
implementation source of truth remains `server/routes/*.ts` and the mirrored
client types in `src/cosheaf/api.ts`.

Base path: `/api/v1`

All JSON routes return `{ error, code }` on expected failures. Browser sessions
use the `sid` cookie. Bot/client access uses a direct Forgejo personal access
token as `Authorization: Bearer <Forgejo PAT>`. Cosheaf validates the PAT,
resolves workspace membership through Forgejo, and forwards the caller's own
Forgejo identity on Forgejo-backed operations.

## Core Types

```ts
type Role = "admin" | "write" | "read";

interface User {
  id: number;
  username: string;
}

interface Workspace {
  id: number;
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
  | "unauthorized"      // 401 — no session / bearer / Forgejo PAT
  | "pat_invalid"       // 401 — Forgejo rejected the stored PAT; SPA reloads to log in
  | "forbidden"         // 403 — authenticated but lacks the required role
  | "not_found"         // 404
  | "method_not_allowed" // 405 (passthrough only)
  | "conflict"          // 409 — Forgejo precondition (merge conflict, dup PR)
  | "forgejo_failed"    // 502 — Forgejo write rejected; carries details.step
  | "reindex_failed"    // 502 — Forgejo updated but sidecar didn't; retry-safe
  | "bad_gateway";      // 502 — Forgejo upstream unreachable / 5xx
```

## Auth

Cosheaf owns the login UX so users do not need to know Forgejo is the backend.
Login exchanges Forgejo username/password credentials for a Cosheaf-managed
Forgejo PAT and stores it encrypted for the browser session. API clients can
skip login and send their own Forgejo PAT as bearer auth.

```http
POST /login
{ "username": string, "password": string }
→ User

POST /logout
→ { "ok": true }

GET /me
→ { "user": User | null }
```

There is no Cosheaf personal-token API. Create and revoke PATs in Forgejo.

## Workspaces

```http
GET /workspaces
→ { "workspaces": Workspace[] }

POST /workspaces
{ "slug": string, "name": string }
→ 201 Workspace
```

Creating a workspace provisions a Forgejo repository, branch protection,
webhook, `.gitattributes`, and the initial sidecar index.

## Forgejo Passthrough

The agent/default Forgejo surface is:

```http
{METHOD} /w/:slug/forgejo/:tail
```

Cosheaf anchors `:tail` under the workspace repository:

```http
/api/v1/repos/{owner}/{repo}/:tail
```

The caller supplies `Authorization: Bearer <Forgejo PAT>` to Cosheaf. Cosheaf
validates membership and forwards the request to Forgejo with the caller's
PAT. Audit happens at the Forgejo access log.

Allowed repo-scoped passthrough prefixes:

- `pulls` with `GET`, `POST`, `PATCH`, `DELETE`
- `issues` with `GET`, `POST`, `PATCH`, `PUT`, `DELETE`
- `labels` with `GET`, `POST`, `PATCH`, `DELETE`
- `milestones` with `GET`, `POST`, `PATCH`, `DELETE`
- `branches` with `GET`
- `commits` with `GET`
- `contents` with `GET`
- `reviews` with `GET`, `POST`
- `markdown` with `POST`
- `activities/feeds` with `GET`
- `notifications` with `GET`, `PUT`

`pulls/:n/merge` is intentionally blocked in passthrough. Use the typed merge
route so Cosheaf can run its fresh-admin gate. `contents` and `branches` are
read-only in passthrough because typed file/branch routes enforce Cosheaf's
path, branch, frontmatter, and indexing rules.

Examples:

```http
GET /w/flushing-coin/forgejo/issues?state=open
PATCH /w/flushing-coin/forgejo/issues/42
PUT /w/flushing-coin/forgejo/issues/42/labels
GET /w/flushing-coin/forgejo/pulls?state=open
GET /w/flushing-coin/forgejo/labels
GET /w/flushing-coin/forgejo/milestones?state=open
GET /w/flushing-coin/forgejo/contents/hello.md
GET /w/flushing-coin/forgejo/notifications?status=unread
```

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

A Markdown write through Forgejo `contents` passthrough is treated as an
external repository edit. It reaches SQLite through webhook or
`pnpm cli workspace reindex <slug>` reconciliation, not through immediate typed
file-route indexing.

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
→ { "activities": ActivityRow[] }   # normalized over Forgejo's activity-feed
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
open pull request. Branches and pull requests live in Forgejo; SQLite does not
mirror them.

## Pull Requests

```http
POST /w/:slug/pulls
{ "head": string, "base"?: string, "title"?: string, "body"?: string }
→ PrMeta

POST /w/:slug/pulls/:n/merge
{ "Do"?: "squash" | "merge" | "rebase", "force"?: boolean }
→ { "ok": true }

POST /w/:slug/pulls/:n/close
→ { "ok": true }
```

Pull request listing and metadata are 1:1 Forgejo reads and should use
passthrough:

```http
GET /w/:slug/forgejo/pulls?state=open|closed|all
GET /w/:slug/forgejo/pulls/:n
```

The SPA normalizes Forgejo pull request JSON to `PrMeta`: `number`, `title`,
`body`, `state`, `merged`, author, head/base refs and SHAs, timestamps,
mergeability, and changed-file counts.

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

GET /w/:slug/pulls/:n/comments
→ { "comments": LineComment[] }

POST /w/:slug/pulls/:n/comments
{ "path": string, "line": number, "side": "base" | "head", "body": string }
→ { "ok": true }
```

Pending review helpers exist because Forgejo represents pending reviews
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

Typed issue routes remain where the SPA needs normalized DTOs, SSE behavior, or
multi-call composition. Plain Forgejo issue operations should use passthrough.

```http
GET /w/:slug/issues?state=open|closed|all&filter=mine|assigned|all&q=<query>
→ { "issues": IssueRow[] }

GET /w/:slug/issues/pinned
→ { "issues": IssueRow[] }

GET /w/:slug/issues/:n
→ IssueDetail

POST /w/:slug/issues
{ "title": string, "body": string }
→ { "number": number, "title": string, "state": "open" | "closed" }

# Issue comment list/create/edit/delete go through passthrough
# (these were typed routes; they're now pure Forgejo shape with the
# SPA normalizing timestamps client-side):
#   GET    /w/:slug/forgejo/issues/:n/comments
#   POST   /w/:slug/forgejo/issues/:n/comments
#   PATCH  /w/:slug/forgejo/issues/comments/:id
#   DELETE /w/:slug/forgejo/issues/comments/:id

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

Labels, milestones, pin/unpin, issue state changes, and raw issue edits use
`/w/:slug/forgejo/*`.

## Notifications

```http
GET /w/:slug/notifications
→ { "notifications": NotificationRow[] }

POST /w/:slug/notifications/:id/read
→ { "ok": true }

POST /w/:slug/notifications/read-all
→ { "ok": true }
```

Repo-scoped notification list and mark-all operations are also available
through passthrough. The single-thread mark-read route stays typed because the
Forgejo endpoint is not repo-anchored.

## Settings

```http
GET /w/:slug/settings
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }

PUT /w/:slug/settings
{ "min_approvals"?: number, "default_md_format"?: "forgejo-passthrough" | "coflat" }
→ { "min_approvals": number, "default_md_format": string, "formats": Array<{ "id": string, "displayName": string }> }
```

Approval settings map to Forgejo branch protection on `main`. The workspace
markdown format controls typed file indexing and SPA rendering. Updating
settings requires admin permission.

## Events

```http
GET /w/:slug/events
```

Server-sent events stream JSON messages for file changes/removals, pull
request updates, reviews, issue updates, and issue comments. Events are
workspace-scoped hints; Forgejo and the typed read routes remain the source of
truth after reconnect.
