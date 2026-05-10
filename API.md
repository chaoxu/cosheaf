# Cosheaf HTTP API (v1)

The cosheaf substrate is reachable only over HTTP. All routes live under
`/api/v1/`. The API is the same surface humans and bots use.

This document is the contract. The source of truth is `server/routes/*.ts`,
but breaking changes here should be intentional, versioned, and noted in the
changelog at the bottom.

- Base URL during dev: `http://localhost:5173/api/v1` (Vite proxies to the
  server) or `http://localhost:3030/api/v1` directly.
- All request bodies are `application/json` unless noted. Responses are JSON.

## Authentication

Two interchangeable mechanisms.

### Session cookie (browser flow)

```
POST /api/v1/login   { "username": "...", "password": "..." }    → 200 { id, username }
POST /api/v1/logout                                              → 200 { ok: true }
GET  /api/v1/me                                                  → 200 { user: User | null }
```

`POST /login` sets an `HttpOnly` session cookie. Send subsequent requests
with that cookie attached. `GET /me` returns `{user: null}` for unauthenticated
clients (it does **not** 401).

### Bearer token (agent / CI flow)

```
GET    /api/v1/tokens                          → 200 { tokens: TokenInfo[] }
POST   /api/v1/tokens         { "name": "..."} → 201 { id, name, token }
DELETE /api/v1/tokens/:id                      → 200 { ok: true }
```

Tokens look like `cs_<random>`. Use them as
`Authorization: Bearer cs_<...>`. Token creation returns the secret value
exactly once; `GET /tokens` only returns metadata.

```
TokenInfo { id: number, name: string, created_at: number }
```

A token authenticates as the user who created it, with that user's
memberships and roles. A revoked token is rejected immediately.

## Document model

Every document on disk has YAML frontmatter:

```yaml
---
id: ksh1jyxe         # stable, generated once on first index
type: page           # page | proposal | review
status: golden       # draft | unreviewed | golden | rejected | archived
target: <id>         # only for proposals and reviews
title: …             # derived from first H1 if absent
---
```

```ts
type DocumentType = "page" | "proposal" | "review";
type DocumentStatus = "draft" | "unreviewed" | "golden" | "rejected" | "archived";

DocumentMeta {
  id: string;
  type: DocumentType;
  status: DocumentStatus;
  title: string | null;
  target_id: string | null;       // only for proposals and reviews
  mtime?: number;
}
```

### Lifecycle

```
draft ── POST /document/:id/submit ──▶ unreviewed
                                          │
                                          ├── /approve (≥ min)──▶ golden     (page)
                                          │                       archived  (proposal: body merged onto target page)
                                          │
                                          └── /reject ─▶ rejected
                                                            │
                                                            └── (edit + submit again) ──▶ unreviewed
```

`min_approvals` is per-workspace, default 1. `approve` and `reject` count as
one decision each, keyed by `(workspace_id, document_id, verifier_user_id)`
— calling either again from the same verifier overwrites the previous one.

## Roles

Set per workspace in the `memberships` table:

| Role       | Can author | Can submit | Can propose | Can review | Can change settings |
| ---------- | ---------- | ---------- | ----------- | ---------- | ------------------- |
| `owner`    | yes        | yes        | yes         | yes        | yes                 |
| `verifier` | yes        | yes        | yes         | yes        | no                  |
| `member`   | yes        | yes        | yes         | no         | no                  |

`approve` / `reject` and `POST /review` require `verifier` or `owner`.

## Errors

Every 4xx response is:

```json
{ "error": "human-readable message", "code": "<stable code>" }
```

Some 4xx responses include extra fields (e.g., `actual_mtime` on a stale write).

| HTTP | Code           | When                                                    |
| ---- | -------------- | ------------------------------------------------------- |
| 400  | `validation`   | Missing or malformed input, illegal cross-reference     |
| 401  | `unauthorized` | No session / bad credentials / unknown bearer token     |
| 403  | `forbidden`    | Authenticated but missing role or membership            |
| 404  | `not_found`    | Workspace, document, or token not found                 |
| 409  | `conflict`     | Stale mtime, illegal state transition, slug already taken |

5xx responses are not part of the contract.

## Workspaces

```
GET  /api/v1/workspaces                                   → { workspaces: Workspace[] }
POST /api/v1/workspaces  { "slug": "notes", "name": "Notes" }
                                                          → 201 { id, slug, name, role }
```

```ts
Workspace { id: number, slug: string, name: string, role: "owner"|"verifier"|"member" }
```

Slug must match `^[a-z0-9][a-z0-9-]*$`. Creator becomes `owner`.

Memberships beyond the creator are managed via the CLI today
(`pnpm cli workspace member <slug> <username> <role>`); there is no HTTP
endpoint for membership management.

## Notes (files)

All routes scoped to a workspace require membership.

### List

```
GET /api/v1/w/:slug/tree                  → { files: FileEntry[] }
GET /api/v1/w/:slug/documents             → { documents: DocumentMeta[] }
GET /api/v1/w/:slug/document/:id          → { document: DocumentMeta }
```

`tree` returns disk-level entries (path, size, mtime) with the indexed
document attached if any. `documents` returns just the indexed documents
ordered by path. `document/:id` is for direct lookup when a client already has
a stable document id and should not list the full workspace.

```ts
FileEntry { path: string, size: number, mtime: number, doc?: DocumentMeta }
```

### Read

```
GET /api/v1/w/:slug/note?path=<rel>       → { content: string, mtime: number }
```

### Write

```
PUT /api/v1/w/:slug/note?path=<rel>
    { "content": "...", "mtime"?: number }
                                          → 200 {
                                                ok: true,
                                                mtime: number,
                                                meta: DocumentMeta,
                                                content?: string,        // if frontmatter was rewritten by the indexer
                                              }
```

Atomic write (tmp + rename). If `mtime` is provided and the on-disk mtime
differs, returns 409 `conflict` with `actual_mtime`. If the document on disk
already has an `id` matching another path, returns 409 `conflict` with
`conflicting_path`.

### Delete

```
DELETE /api/v1/w/:slug/note?path=<rel>    → { ok: true }
```

### Search (FTS5)

```
GET /api/v1/w/:slug/search?q=<query>      → { results: SearchResult[] }
GET /api/v1/w/:slug/search?q=<query>&status=golden&type=page&limit=10
                                         → { results: SearchResult[] }
```

```ts
SearchResult {
  doc_id: string,
  path: string,
  title: string|null,
  type: "page"|"proposal"|"review",
  status: DocumentStatus,
  target_id: string|null,
  snippet: string,
  rank: number,
}
```

`snippet` is server-rendered HTML containing `<mark>` tags around hits — safe
to insert with `dangerouslySetInnerHTML` in trusted UI; bots should treat it
as HTML, not plain text.

`status` and `type` filters are repeatable. `limit` is clamped to `1..50`.

### Backlinks

```
GET /api/v1/w/:slug/backlinks?id=<doc_id> → { backlinks: Backlink[] }
```

```ts
Backlink { src_id: string, src_path: string, src_title: string|null, target_label: string }
```

`target_label` is the `[@id]` reference text the source page uses for the
target. Multiple labels for the same source page produce multiple rows.

### File events (SSE)

```
GET /api/v1/w/:slug/events
```

`text/event-stream`. Emits one `ready` event on connect, then `change` /
`remove` events as the workspace directory is modified (by any writer,
including the API itself when external writers haven't been suppressed).

```ts
event: "ready",  data: { type: "ready" }
event: "change", data: { type: "change", path: string, doc: DocumentMeta }
event: "remove", data: { type: "remove", path: string }
event: "ping",   data: {}                                      // every 30s, keep-alive
```

The server suppresses watcher events caused by its own writes within a
~750 ms window so subscribers don't see echoes.

## Workflow

### Settings

```
GET /api/v1/w/:slug/settings              → { min_approvals: number }
PUT /api/v1/w/:slug/settings              → { ok: true, min_approvals }    [owner only]
    { "min_approvals": 2 }
```

### Submit / approve / reject

```
POST /api/v1/w/:slug/document/:id/submit  → { status: "unreviewed" }

POST /api/v1/w/:slug/document/:id/approve [verifier]
     { "comment"?: string|null, "review_doc_id"?: string|null }
                                          → DecisionResult

POST /api/v1/w/:slug/document/:id/reject  [verifier]
     { "comment"?: string|null, "review_doc_id"?: string|null }
                                          → DecisionResult
```

```ts
DecisionResult {
  decision: "approve" | "reject",
  approvals: number,           // running tally for this document
  rejections: number,
  doc_status: DocumentStatus,
  promoted_meta?: DocumentMeta,  // page status after threshold reached
}
```

`comment` is a one-liner stored on the approval row. `review_doc_id`
references a `review` document targeting this same `:id` (created with
`POST /review` first); the row's `comment` and `review_doc_id` are
independent — you can supply both, either, or neither.

If the reviewer already has a row for this document, calling approve/reject
again overwrites the prior decision (and its comment / review link).

### List approvals

```
GET /api/v1/w/:slug/document/:id/approvals → { approvals: ApprovalRecord[] }
GET /api/v1/w/:slug/document/:id/reviews   → { reviews: ReviewRecord[] }
GET /api/v1/w/:slug/document/:id/reviews?include_body=false
                                            → { reviews: ReviewRecord[] }
```

```ts
ApprovalRecord {
  verifier_user_id: number,
  username: string,
  decision: "approve" | "reject",
  comment: string | null,
  review_doc_id: string | null,
  review_path: string | null,        // joined from documents table
  review_title: string | null,
  created_at: number,
}
```

```ts
ReviewRecord {
  verifier_user_id: number,
  username: string,
  decision: "approve" | "reject",
  comment: string | null,
  created_at: number,
  review_doc_id: string,
  review_path: string,
  review_title: string | null,
  meta: DocumentMeta,
  content?: string,
}
```

`reviews` returns only approval rows that have an attached review document.
By default `content` contains the full Markdown file content.

### Review queue

```
GET /api/v1/w/:slug/queue                 → { queue: QueueEntry[] }
```

```ts
QueueEntry {
  id: string, path: string, title: string|null,
  type: "page"|"proposal"|"review",
  target_id: string|null,
  approvals: number, rejections: number,
  submitted_at: number,
}
```

Returns only `unreviewed` documents.

### Proposals

```
POST /api/v1/w/:slug/proposal             → 201 { path, meta: DocumentMeta }
     { "target_id": "<page id>", "body": "<markdown>" }
```

Creates a `proposal` document under `proposals/<target_id>-<stamp>-<author>.md`
with `type=proposal, status=draft, target=<target_id>`. Submit + approve as
usual; on the approval that reaches `min_approvals`, the proposal body
replaces the target page's body and the proposal becomes `archived`.

```
GET /api/v1/w/:slug/proposal/:id/target   → {
                                              target_id: string,
                                              target_path: string,
                                              target_title: string|null,
                                              target_content: string,
                                            }
```

The full current body of the proposal's target page — used to compute the
diff that reviewers see.

### Reviews

```
POST /api/v1/w/:slug/review               → 201 { path, meta: DocumentMeta }   [verifier]
     { "target_id": "<doc id>", "body"?: "<markdown>" }
```

Creates a `review` document under `reviews/<target_id>-<stamp>-<author>.md`.
Reviews are first-class documents: searchable, backlinked, citable. To
attach a review to an approval, pass its `id` as `review_doc_id` when calling
`approve` or `reject` on the target document.

The review document itself is independent of the workflow tally — it can be
edited freely, stays in `draft` until the author submits it, and need not
follow the same lifecycle as the document it reviews.

## Health

```
GET /api/v1/health                        → { ok: true }
```

No auth required.

## Changelog

- **v1 additive** — search filters and `GET /w/:slug/document/:id/reviews`.
- **v1 additive** — `GET /w/:slug/document/:id` for direct document lookup.
- **v1 (initial)** — every endpoint above. The contract is stable in the
  sense that future v1 changes are additive (new fields on responses, new
  optional request fields). Breaking changes will ship under `/api/v2` with
  a deprecation note here.
