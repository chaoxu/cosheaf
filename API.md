# Cosheaf API

This document is the human-facing contract for the current HTTP API. The
implementation source of truth remains `server/routes/*.ts` and the mirrored
client types in `src/cosheaf/api.ts`.

Base path: `/api/v1`

All JSON routes return `{ error, code }` on expected failures. Browser sessions
use the `sid` cookie. Bot/client access can use `Authorization: Bearer cs_...`
personal tokens.

## Core Types

```ts
type Role = "owner" | "verifier" | "member";
type ChangeState = "draft" | "review" | "merged" | "rejected" | "abandoned";

interface User {
  id: number;
  username: string;
}

interface Workspace {
  id: number;
  slug: string;
  name: string;
  role: Role;
}

interface DocumentMeta {
  id: string;
  type: "page";
  status: "golden";
  title: string | null;
}

interface FileEntry {
  path: string;
  size: number;
  doc?: DocumentMeta;
}

interface Change {
  id: string;
  workspace_id: number;
  author_user_id: number;
  branch_name: string;      // change/<id>
  state: ChangeState;
  pr_number: number | null;
  base_sha: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
}
```

`DocumentMeta.status` is currently always `"golden"` for indexed pages on
Forgejo `main`; draft/review state lives on `Change`, not page frontmatter.

## Auth

```http
POST /login
{ "username": string, "password": string }
→ User

POST /logout
→ { "ok": true }

GET /me
→ { "user": User | null }
```

## Personal Tokens

```http
GET /tokens
→ { "tokens": Array<{ id: number, name: string, created_at: number }> }

POST /tokens
{ "name": string }
→ { "id": number, "name": string, "token": string }

DELETE /tokens/:id
→ { "ok": true }
```

## Workspaces

```http
GET /workspaces
→ { "workspaces": Workspace[] }

POST /workspaces
{ "slug": string, "name": string }
→ 201 Workspace
```

Creating a workspace provisions a Forgejo repository, owner membership, branch
protection, webhook, `.gitattributes`, and the initial sidecar index.

## Files

Workspace routes require membership.

```http
GET /w/:slug/tree?change_id=<id>
→ { "files": FileEntry[] }

GET /w/:slug/file?path=<path>&change_id=<id>
→ { "content": string }

PUT /w/:slug/file?path=<path>&change_id=<id>
{ "content": string }
→ { "ok": true, "change_id": string, "meta": DocumentMeta, "content"?: string, "pending"?: boolean }

DELETE /w/:slug/file?path=<path>&change_id=<id>
→ { "ok": true, "change_id": string, "pending": boolean }
```

Writes target a draft change branch. If `change_id` is omitted, the server
creates or reuses the caller's open draft change.

## Search And Backlinks

```http
GET /w/:slug/search?q=<query>&limit=<n>
→ { "results": SearchResult[] }

interface SearchResult {
  doc_id: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  target_id: string | null;
  snippet: Array<{ text: string, match: boolean }>;
  rank: number;
}
```

`snippet` is structured plain text. Render segments with `match: true` as
highlighted text; clients should not treat snippets as HTML.

```http
GET /w/:slug/backlinks?id=<doc_id>
→ { "backlinks": Backlink[] }

interface Backlink {
  src_id: string;
  src_path: string;
  src_title: string | null;
  target_label: string;
}
```

Indexed links are `[@id]` and `[text](relative.md[#fragment])`.

## Changes

```http
GET /w/:slug/changes
→ { "changes": Change[] }

POST /w/:slug/change
{ "title"?: string }
→ 201 Change

DELETE /w/:slug/change/:id
→ { "ok": true }
```

Only the change author can abandon a non-terminal change.

```http
POST /w/:slug/publish
{ "change_id": string, "mode"?: "direct" | "review", "title"?: string, "body"?: string }
→ PublishResult

interface PublishResult {
  ok: boolean;
  mode?: "direct" | "review";
  change_id?: string;
  pr_number?: number;
  message?: string;
}
```

Owners may publish directly, which opens/reuses a PR, auto-approves as the
Forgejo owner to satisfy branch protection, and merges. Members and verifiers
publish to review.

## Review

```http
GET /w/:slug/queue
→ { "queue": QueueEntry[] }

interface QueueEntry {
  id: string;
  title: string;
  pr_number: number | null;
  author_user_id: number;
  created_at: number;
  approvals: number;
  rejections: number;
}

POST /w/:slug/change/:id/approve
{ "comment"?: string | null }
→ DecisionResult

POST /w/:slug/change/:id/reject
{ "comment"?: string | null }
→ DecisionResult

interface DecisionResult {
  decision: "approve" | "reject";
  change_id: string;
  state: ChangeState;
  approvals: number;
  rejections: number;
}

GET /w/:slug/change/:id/approvals
→ { "approvals": ApprovalRecord[] }

interface ApprovalRecord {
  verifier_user_id: number;
  username: string;
  decision: "approve" | "reject";
  comment: string | null;
  created_at: number;
}
```

Approvals and rejections are Forgejo pull-request reviews. When approvals meet
the branch-protection threshold and there are no outstanding request-changes
reviews, the server attempts to merge and marks the change `merged`.

## Settings

```http
GET /w/:slug/settings
→ { "min_approvals": number }

PUT /w/:slug/settings
{ "min_approvals": number }
→ { "min_approvals": number }
```

Settings map to Forgejo branch protection on `main`. Updating settings requires
the `owner` role.

## Events

```http
GET /w/:slug/events
```

Server-sent events stream JSON messages. Current event types include file
changes, file removals, and change lifecycle updates such as
`change_review`, `change_approved`, `change_merged`, `change_rejected`, and
`change_abandoned`.
