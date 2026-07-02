# AI Client Guide

Cosheaf is the public interface that AI clients should use. Forgejo stores the
durable repository data behind Cosheaf, but agents should not call Forgejo
directly for normal workspace workflows.

Use this guide when an agent needs to read or update pages, open pull requests,
triage issues, or merge reviewed work in a Cosheaf workspace.

For local Workbench and Origin API boundary work, also read
`docs/workbench-origin-split.md`. That document defines which operations belong
to the local git workbench versus the remote Cosheaf server authority.

Cosheaf login returns an opaque `cosheaf_...` token. That token is valid only at
Cosheaf; it is not a Forgejo PAT and should fail if sent to the backing forge.
The server keeps the Forgejo credential internally when it needs to delegate to
the backend.

Cosheaf accepts the token as either `Authorization: Bearer <token>` or
Gitea/tea's `Authorization: token <token>`. Both forms carry the same opaque
Cosheaf token, not a Forgejo PAT.

## Use The CLI First

For the common "write these local Markdown files to a branch and open a PR"
workflow, use the tea-shaped helper:

```sh
COSHEAF_TOKEN="<cosheaf-api-token>" \
pnpm cosheaf:tea -- \
  --api "https://cosheaf-test.lab/api/v1" \
  --workspace "chao/flushing-coin" \
  pr-from-files \
  --branch "agent/update-notes" \
  --title "Update notes" \
  --file "notes/update.md=local-update.md"
```

Use `--dry-run` to print the planned Cosheaf operations without requiring a
token or calling the server:

```sh
pnpm cosheaf:tea -- \
  --workspace "chao/flushing-coin" \
  pr-from-files \
  --branch "agent/update-notes" \
  --title "Update notes" \
  --file "notes/update.md=local-update.md" \
  --dry-run
```

The helper is intentionally shaped like familiar `tea`/Forgejo tooling, but it
calls Cosheaf typed routes internally. That preserves Cosheaf's document
handling while keeping the command surface easy for agents.

Check the live Cosheaf URL against the supported `tea` endpoint subset with:

```sh
pnpm cosheaf:tea-check -- --api "https://cosheaf-test.lab/api/v1" --workspace "chao/flushing-coin"
```

Add `--write-check` when it is acceptable to create and clean up a temporary
branch and Markdown file through the Gitea-shaped `/contents` route.

## Local Workbench Writing Queue

When Cosheaf is running as a local Workbench over a folder, local annotations
are a private writing task queue for the user and local agents. They are not
Core issues, pull-request review comments, or shared collaboration records.
The durable source is the gitignored sidecar:

```text
<workspace>/.cosheaf/local-annotations.json
```

Use these routes only against the local Workbench URL for the opened folder:

| Workflow | Local Workbench route |
| --- | --- |
| List annotations | `GET /api/v1/repos/$OWNER/$REPO/local-annotations?path=paper.md` |
| List unresolved queue | `GET /api/v1/repos/$OWNER/$REPO/local-annotations/unresolved` |
| Create local note/task | `POST /api/v1/repos/$OWNER/$REPO/local-annotations` |
| Append progress message | `POST /api/v1/repos/$OWNER/$REPO/local-annotations/$ID/messages` |
| Resolve or reopen | `PATCH /api/v1/repos/$OWNER/$REPO/local-annotations/$ID` |
| Delete local annotation | `DELETE /api/v1/repos/$OWNER/$REPO/local-annotations/$ID` |

The basic local agent loop is:

1. List unresolved annotations.
2. Read each item's `path`, `anchor`, `kind`, messages, and `context` fields
   such as `context.excerpt` and `context.anchor_found`.
3. Edit the Markdown file in the local workspace, keeping or removing the
   `[@local:<id>]` marker according to the task.
4. Append a message explaining what changed.
5. Resolve the annotation when the document no longer needs that local note.

Final PDF export fails while local markers remain in the source or while open
sidecar annotations are detached from their anchors. Resolve/delete local
annotations before treating the document as publishable.

## Instruction Block

Put this in the agent's workspace instructions, system prompt, or project
`AGENTS.md`:

```markdown
When working with a Cosheaf workspace, use the Cosheaf typed API, not Forgejo
directly. Authenticate Cosheaf requests with `Authorization: Bearer <token>`.
Tea/Gitea-compatible clients may instead send
`Authorization: token <token>`.

Repository pages, branches, pull requests, issues, labels, milestones, reviews,
notifications, and merges are exposed under:

`/api/v1/repos/<owner>/<repo>/...`

Do not construct `/forgejo/...` URLs, send Forgejo-shaped request bodies, or
depend on Forgejo response fields. Cosheaf validates workspace membership,
applies Coflat frontmatter/id handling, emits browser events, and keeps merge
safety checks on its typed routes.

For page edits that should become a PR, prefer the repo-local CLI:

`pnpm cosheaf:tea -- --workspace <owner>/<repo> pr-from-files --branch <branch> --title <title> --file <workspace-path=local-path>`

If using raw HTTP instead of the CLI:

1. Create a branch with `POST /branches`.
2. Read or write files with `GET` or `PUT /file?path=<path>&branch=<branch>`.
3. Open a PR with `POST /pulls`.
4. List or inspect the PR through `GET /pulls` or `GET /pulls/<number>`.
5. Review through `POST /pulls/<number>/reviews`.
6. Merge through `POST /pulls/<number>/merge` only when policy allows it.

Read-after-write consistency for branch file content requires the typed file
route. Search, backlinks, and document metadata update after the change lands on
`main` and Cosheaf reconciles the webhook or reindex.
```

## Forgejo-Shape Compatibility

Cosheaf supports a tea/Gitea-shaped subset for ordinary agent workflows. It is
not a raw Forgejo proxy and is not a complete 1:1 Forgejo API contract.

Supported Forgejo-shaped routes include:

- Repository metadata: `GET /repos/:owner/:repo`
- Branches: `GET/POST /repos/:owner/:repo/branches`
- File content: `GET/POST/PUT/DELETE /repos/:owner/:repo/contents/:path`
- Pull requests: `GET/POST /repos/:owner/:repo/pulls`
- Issues: `GET/POST/PATCH /repos/:owner/:repo/issues...`
- Labels and milestones: `GET/POST/PATCH/DELETE /labels` and `/milestones`

Those routes are implemented at the Cosheaf edge. They translate into typed
Cosheaf behavior and use the server-side backend credential. They do not expose
the backing Forgejo URL or accept backend tokens by default.

Routes that remain Cosheaf-owned:

- Merge. Forgejo-shaped clients must still call Cosheaf's
  `/pulls/:number/merge` route because it runs the admin freshness gate before
  delegating to the backend.
- Search, backlinks, suggestions, validation, and events. These are Cosheaf
  sidecar/document features and do not have a direct Forgejo/Gitea equivalent.

Prefer the typed `/file?path=<path>&branch=<branch>` route for new Cosheaf-aware
clients because it sends Markdown content directly. Use `/contents/:path` for
tea/Gitea-compatible clients; Markdown writes still go through Cosheaf
frontmatter/id handling, path validation, SSE events, and sidecar rules.

## Endpoint Map

All examples use:

```sh
BASE_URL="https://cosheaf-test.lab"
OWNER="chao"
REPO="flushing-coin"
COSHEAF_TOKEN="<cosheaf-api-token>"
```

Use the local development URL, `http://127.0.0.1:3030`, when running
`pnpm dev:all`.

| Workflow | Typed route |
| --- | --- |
| Origin capability manifest | `GET /api/v1/origin` |
| Repository metadata | `GET /api/v1/repos/$OWNER/$REPO` |
| List branches | `GET /api/v1/repos/$OWNER/$REPO/branches` |
| Create branch | `POST /api/v1/repos/$OWNER/$REPO/branches` |
| Read file | `GET /api/v1/repos/$OWNER/$REPO/file?path=...&branch=...` |
| Write file | `PUT /api/v1/repos/$OWNER/$REPO/file?path=...&branch=...` |
| Delete file | `DELETE /api/v1/repos/$OWNER/$REPO/file?path=...&branch=...` |
| Gitea-shaped file read/write | `GET/POST/PUT/DELETE /api/v1/repos/$OWNER/$REPO/contents/...` |
| Search sidecar index | `GET /api/v1/repos/$OWNER/$REPO/search?q=...` |
| List pull requests | `GET /api/v1/repos/$OWNER/$REPO/pulls?state=open` |
| Open pull request | `POST /api/v1/repos/$OWNER/$REPO/pulls` |
| Review pull request | `POST /api/v1/repos/$OWNER/$REPO/pulls/<number>/reviews` |
| Merge pull request | `POST /api/v1/repos/$OWNER/$REPO/pulls/<number>/merge` |
| List issues | `GET /api/v1/repos/$OWNER/$REPO/issues?state=open` |
| Comment on issue | `POST /api/v1/repos/$OWNER/$REPO/issues/<number>/comments` |
| Close issue | `PATCH /api/v1/repos/$OWNER/$REPO/issues/<number>/state` |
| Notifications | `GET /api/v1/repos/$OWNER/$REPO/notifications` |

## Edit-To-PR Flow

Create a branch:

```sh
curl -X POST "$BASE_URL/api/v1/repos/$OWNER/$REPO/branches" \
  -H "Authorization: Bearer $COSHEAF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"agent/update-notes"}'
```

Write a page on that branch. Use this route even if the agent already knows how
to push Git commits, because Cosheaf applies the workspace file rules here:

```sh
curl -X PUT "$BASE_URL/api/v1/repos/$OWNER/$REPO/file?path=notes/update.md&branch=agent/update-notes" \
  -H "Authorization: Bearer $COSHEAF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"content":"# Updated note\n\nBody text.\n"}'
```

Open the pull request:

```sh
curl -X POST "$BASE_URL/api/v1/repos/$OWNER/$REPO/pulls" \
  -H "Authorization: Bearer $COSHEAF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"head":"agent/update-notes","base":"main","title":"Update notes"}'
```

Before retrying `POST /pulls`, list open PRs and check for the same head/base
pair. Creating a pull request is not idempotent.

```sh
curl "$BASE_URL/api/v1/repos/$OWNER/$REPO/pulls?state=open" \
  -H "Authorization: Bearer $COSHEAF_TOKEN"
```

Submit a review:

```sh
curl -X POST "$BASE_URL/api/v1/repos/$OWNER/$REPO/pulls/42/reviews" \
  -H "Authorization: Bearer $COSHEAF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"event":"APPROVE","body":"Looks good."}'
```

Merge through Cosheaf so the route keeps the admin freshness checks:

```sh
curl -X POST "$BASE_URL/api/v1/repos/$OWNER/$REPO/pulls/42/merge" \
  -H "Authorization: Bearer $COSHEAF_TOKEN" \
  -H "content-type: application/json" \
  -d '{"Do":"squash"}'
```

## What Not To Do

- Do not call Forgejo REST routes from AI clients for normal workspace work.
- Do not push Markdown directly to the backing repository when Cosheaf needs
  immediate frontmatter, id, branch file, or browser-event behavior.
- Do not mirror Forgejo objects into a separate client-side workflow model.
- Do not retry `POST /pulls` blindly; check for an existing PR first.
- Do not merge by calling the backend forge directly; Cosheaf's typed merge
  route owns the extra safety gate.

## Consistency Rules

Cosheaf's sidecar index mirrors `main`. Branch writes are readable through the
typed file route, but they do not publish unmerged content into search,
backlinks, page metadata, or other `main`-indexed views.

External repository writes are reconciled by webhook or by:

```sh
pnpm cli workspace reindex <owner>/<repo>
```

Agents that need immediate branch read-after-write behavior should use
`PUT /file` and then read the same path and branch with `GET /file`.
