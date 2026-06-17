# Cosheaf

Human-usable knowledge base for Coflat-flavored markdown. Forgejo repositories
hold the canonical markdown files, branches, pull requests, reviews, issues,
and collaborator memberships; SQLite is a derived sidecar for fast reads and
small Cosheaf-owned credentials. The credential is a Forgejo PAT, sent either
as `Authorization: Bearer <token>` by API clients and agents or as an HttpOnly
`cosheaf_pat` cookie for server-rendered web pages.

The long-term direction is a thin knowledge-base UI over a Forgejo-style
forge. Cosheaf should feel like a focused repository interface with custom
Coflat rendering and indexing, not a separate CMS with its own workflow model.
When adding features, prefer Cosheaf routes whose concepts map cleanly to the
backing forge before inventing a separate workflow abstraction.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is math-friendly. Still, Cosheaf is page-oriented rather than
math-native: do not add theorem graphs, proof dependency models, or other
semantic math layers unless explicitly requested.

Coflat markdown is one of the document formats cosheaf supports, alongside
Forgejo Markdown passthrough. The codebase carries a `DocumentFormat` seam
(`server/document-format/`, `src/cosheaf/document-format/`) so additional
formats can be added cleanly later; register formats through the format
registry rather than reaching into one implementation's internals.
Don't add another format until one is asked for.

Agent/prover internals (Coverify and friends) are out of scope here. They live
in a separate layer and participate as ordinary Forgejo write-access
collaborators over the same HTTP API. Cosheaf may provide a thin issue-backed
chat surface and optional launcher for that external layer, but keep cosheaf's
surface usable without any automation.

## Shared file

`AGENTS.md` is the canonical shared instructions file for both `AGENTS.md` and
`CLAUDE.md` (the latter is a symlink). Update one and the other follows.

## Core principles

- **Forgejo is source of truth.** Every page is a `.md` file on the workspace
  repo's `main` branch. Work lives on branches and moves through Forgejo pull
  requests. Issues, comments, labels, milestones, reviews, and merge state
  should come from Forgejo wherever practical.
- **Thin shell over forge concepts.** Prefer repository, branch, pull request,
  review, issue, comment, label, milestone, notification, merge, and close over
  Cosheaf-specific workflow terms. Durable operations should be understandable
  and usually reproducible directly in Forgejo.
- **Do not fork the workflow model.** Avoid database-only drafts, proposals,
  reviews, issue boards, or permissions that can diverge from Forgejo. If local
  state is needed for speed or UX, treat it as cache/mapping/reconciliation
  state with a clear Forgejo source.
- **No hidden database-only knowledge.** SQLite stores document metadata,
  links, FTS index, webhook dedupe, and cached Cosheaf-issued Forgejo PATs —
  keyed by the Forgejo `owner/repo` full name or username. There is no users,
  sessions, or workspaces table; identity, workspace registry, memberships,
  branches, pull requests, issues, labels, milestones, and notifications all
  live on Forgejo and are read on demand (the workspace format lives in a
  `cosheaf-format-*` repo topic). Passthrough calls are not audited locally —
  Forgejo's access log is the trail. The page index is rebuildable from Forgejo
  via `pnpm cli workspace reindex <owner>/<repo>`.
- **Stable identity via frontmatter.** Every page has an `id` in its YAML
  frontmatter. The indexer records missing ids in SQLite; canonical writes can
  add frontmatter before persisting content.
- **Workflow as trust, not automation.** Branches, pull requests, reviews, and
  merges are the same whether the proposer is a human or a bot. Cosheaf does
  not distinguish service-account PATs from human PATs: an agent's review
  counts identically to a human's for required-approvals gating, and an
  agent's commit attribution is whatever Forgejo records.

## Web UI direction

Cosheaf's browser experience is server-rendered, page-based, and
Forgejo-route-shaped. React is not the owner of top-level navigation.
Use normal links and forms for repository, file, issue, pull-request, branch,
activity, and settings pages; reserve client-side islands for interactions
that truly need local state (for example a rich Coflat editor or an advanced
review widget).

Primary web routes should mirror Forgejo where practical:

- `/:owner/:repo`
- `/:owner/:repo/src/branch/:branch/*path`
- `/:owner/:repo/raw/branch/:branch/*path`
- `/:owner/:repo/issues` and `/:owner/:repo/issues/:number`
- `/:owner/:repo/pulls` and `/:owner/:repo/pulls/:number`
- `/:owner/:repo/pulls/:number/files`
- `/:owner/:repo/branches`
- `/:owner/:repo/activity`
- `/:owner/:repo/settings`

Cosheaf-specific routes should be visibly private/tool-like, e.g.
`/:owner/:repo/_edit`. Do not add top-level SPA modes for durable resources.
If a screen has a durable identity, give it a server route first.

The pre-migration SPA shell is deprecated and removed. The archival tag is
`spa-shell-2026-05-24`; do not restore `index.html`, `src/cosheaf/main.tsx`,
`src/cosheaf/app.tsx`, browser UI under `/app` or `/w`, localStorage PAT auth,
or catch-all app-shell fallback routes. Typed `/api/v1/repos/:owner/:repo/*`
routes remain the public API for agents and page islands; they are not browser
UI routes.

Server-rendered pages must preserve the old app's useful feature depth. The
intended pattern is a server-rendered shell with narrowly scoped React islands,
not a downgrade to plain forms for interactions that need editor state.
Editing, rich review/diff controls, and future Coflat-editor interactions
should reuse package contracts and typed Cosheaf API routes inside a
page-owned island.

When changing a durable web surface, run a feature-parity checklist against
the server-rendered route:

- editor: Coflat rich/source modes, document theme, outline, dirty state,
  autosave/Cmd-S, manual save, branch context, asset upload, autocomplete,
  open-PR and merge affordances
- PR files: source/rich modes, unified/split/after views, comments, review
  submission gates, author self-review gate, merge gate, browser navigation
- issues: markdown rendering, comments, timeline, state changes, labels,
  milestones, dependencies, browser back/forward
- settings: current values render, form submit works, permission gates hold
- auth/assets: cookie login, API bearer login, logout, built `/assets/*`,
  Vite dev entrypoints, no browser console/page errors
- layout: desktop and narrow viewport do not hide controls or constrain
  documents unexpectedly

When adding a Vite entrypoint for a page island, verify the production path in
the same patch: `vite build` must emit the manifest entry, the server must load
the manifest entry, `/assets/*` must serve built island assets, and a browser
smoke must prove the island mounts with no 4xx asset responses. In
local development, server-rendered pages should load island modules from the
Vite dev server; production should load from the built manifest. Do not let a
stale local `dist/.vite/manifest.json` override Vite dev assets. If Vite
injects package CSS with root-relative `/node_modules/*` font or image URLs,
the dev server route must proxy those URLs before the web router so browser
smoke can keep enforcing the no-4xx asset invariant.

## Future direction

The Forgejo-shell direction is tracked across two open umbrella issues:
**#11** (branch-native + Forgejo terminology) and **#12** (API mirrors
Forgejo shape where divergence is cosmetic). #7 captured the original
architectural pivot and is substantially executed. Future work should
move in small, reversible steps:

- Make editing branch-native: use real branch names as the primary identity for
  work in progress; keep local branch ids, where still present, as cache
  details.
- Make review pull-request-native: prefer PR numbers, head/base branches,
  review states, review comments, and Forgejo merge behavior over change-centric
  Cosheaf vocabulary.
- Keep the issue board close to Forgejo issues: labels, milestones, pinned
  state, dependencies/blocks, comments, and timeline should be mediated only
  where Cosheaf adds knowledge-base rendering or links.
- Keep API shapes Forgejo-like where possible (`/branches`, `/pulls`,
  `/issues`, file contents) and retire older wrappers when the Forgejo-like
  route is in place.
- Treat webhooks and repair/reindex commands as the reconciliation path from
  Forgejo into SQLite.
- Review/simplify checklist for Forgejo-shell issues: prefer Cosheaf's typed
  branch, PR, issue, review, label, milestone, notification, and file routes
  for public clients; keep Forgejo details behind route implementations; delete
  old token and wrapper language as the Forgejo-native path lands.

Forgejo-only: Gitea is not a supported target. Don't add Gitea-compatibility
hedging or version-sensitivity caveats; assume Forgejo behavior.

### Agent API and typed routes

Agents and external tools must use the typed Cosheaf workspace API. Forgejo is
currently the durable backend, but it is an implementation detail: public
client code should not construct `/forgejo/...` paths, send Forgejo-shaped
request bodies, or rely on Forgejo response fields such as `head.ref` or
`user.login`.

The typed routes live in `routes/pulls.ts`, `routes/issues.ts`,
`routes/files.ts`, `routes/branches.ts`, and `routes/notifications.ts`. Keep or
add them when a workflow needs a stable public contract, validation, response
shaping, sidecar integration, SSE events, or Cosheaf-specific gates (e.g.
`requireAdminFresh` on merge). Do not add a raw backend passthrough route; if a
normal workflow needs an API surface, add a typed Cosheaf route.

Typed routes are the public contract for Cosheaf document/index behavior:

- Use `routes/files.ts` for page reads/writes that should synchronously apply
  Coflat frontmatter/id handling, path validation, and browser events. The
  sidecar index (backlinks, FTS, page metadata) mirrors `main`; branch writes
  do not publish unmerged content into it.
- Use typed search, backlinks, document-list, and event routes when callers
  need the SQLite sidecar index rather than raw backend repository contents.
- Use typed branch, pull, issue, label, milestone, notification, and markdown
  routes for normal workspace automation.
- Use typed merge/admin routes where Cosheaf adds freshness checks or other
  UI safety gates before calling the backend forge.

File-write boundary: a Markdown write made outside Cosheaf is an external
repository write from Cosheaf's point of view. Webhooks and `pnpm cli workspace
reindex <owner>/<repo>` reconcile `main` into SQLite. A Markdown branch write
that needs immediate Cosheaf frontmatter/SSE behavior should go through the
typed file route; search/backlinks/doc metadata update after merge webhook or
reindex.

Cosheaf does not synchronously run the indexer or emit SSE on external backend
writes. Reconciliation is webhook-only. Callers (including agents) that need
read-after-write consistency for branch file content should use the typed file
route; callers that need sidecar search/backlink consistency must wait for the
change to land on `main` and reconcile.

Examples for agents using a Cosheaf API token (the workspace is the
`chao/flushing-coin` repo):

- `GET /api/v1/repos/chao/flushing-coin/issues?state=open`
- `PATCH /api/v1/repos/chao/flushing-coin/issues/42/state` with `{ "state": "closed" }`
- `GET /api/v1/repos/chao/flushing-coin/pulls?state=open`
- `GET /api/v1/repos/chao/flushing-coin/labels`
- `GET /api/v1/repos/chao/flushing-coin/milestones?state=open`
- `GET /api/v1/repos/chao/flushing-coin/file?path=hello.md&branch=main`
- `GET /api/v1/repos/chao/flushing-coin/notifications`

Use `Authorization: Bearer <token>` on these Cosheaf requests; Cosheaf
validates workspace membership and translates to the backend credential
internally.

Rules of thumb:

- Don't add raw backend passthrough routes.
- Keep protected operations behind typed routes (e.g. `pulls/:n/merge` must
  keep running `requireAdminFresh`).
- Don't mirror backend forge state into SQLite just to filter on it; compose
  backend filters inside typed routes and return stable Cosheaf DTOs.

### Agent flows

Three common flows. Each works with `curl` against a running cosheaf
(`pnpm dev:all`) using a Cosheaf API token as the Bearer token. Replace
`$OWNER`, `$REPO`, `$PAT`, etc. (the dev fixture is `chao`/`flushing-coin`).

**1. Add a page on a work branch.** Use the typed file route so frontmatter is
applied immediately; open and merge a PR to land it on `main`, where the
sidecar search/backlink index is reconciled by the merge push webhook:

```sh
curl -X PUT "http://localhost:3030/api/v1/repos/$OWNER/$REPO/file?path=notes/new.md&branch=agent/wip-1" \
  -H "Authorization: Bearer $PAT" \
  -H "content-type: application/json" \
  -d '{"content": "# New page\n\nbody."}'
```

**2. Open a PR, get a review, merge.**

```sh
# Create branch
curl -X POST "http://localhost:3030/api/v1/repos/$OWNER/$REPO/branches" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"name": "agent/wip-1"}'

# Edit a file on the branch (typed route applies frontmatter/id handling)
curl -X PUT "http://localhost:3030/api/v1/repos/$OWNER/$REPO/file?path=notes/new.md&branch=agent/wip-1" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"content": "# Updated\n\nbody."}'

# Open PR
curl -X POST "http://localhost:3030/api/v1/repos/$OWNER/$REPO/pulls" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"head": "agent/wip-1", "base": "main", "title": "Update notes/new.md"}'

# Submit a review
curl -X POST "http://localhost:3030/api/v1/repos/$OWNER/$REPO/pulls/42/reviews" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"event": "APPROVE", "body": "looks good"}'

# Merge (typed route — runs requireAdminFresh)
curl -X POST "http://localhost:3030/api/v1/repos/$OWNER/$REPO/pulls/42/merge" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"Do": "squash"}'
```

**3. Triage issues.**

```sh
# List my open issues
curl "http://localhost:3030/api/v1/repos/$OWNER/$REPO/issues?state=open&filter=assigned" \
  -H "Authorization: Bearer $PAT"

# Comment on one
curl -X POST "http://localhost:3030/api/v1/repos/$OWNER/$REPO/issues/17/comments" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"body": "investigating"}'

# Close it
curl -X PATCH "http://localhost:3030/api/v1/repos/$OWNER/$REPO/issues/17/state" \
  -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -d '{"state": "closed"}'
```

Notes for agent retry logic:

- Reading after an external backend write through cosheaf's typed routes is not
  immediately consistent — the webhook reconciles asynchronously. If you need
  branch file read-your-write, use the typed file route. If you need sidecar
  search/backlink consistency, wait until the change lands on `main` and is
  reconciled.
- Typed `PUT /file`, `PATCH /issues/:n/state`, `DELETE /issues/:n/comments/:id`,
  and `DELETE /pulls/:n/comments/:id` are idempotent enough for normal
  client retry.
- `POST pulls` is **not** idempotent — retry produces a duplicate PR.
  Check for an existing open PR with the same head/base before retrying.
- `POST pulls/:n/merge` retries internally on Forgejo's transient 405
  "try again later"; you don't need to retry it from outside.

Do not rewrite the app, build a generic CMS, add arbitrary document-format
plugins, or move gatherer/oracle/prover logic into this repo as part of this
direction.

## Stack

- **Server**: Hono on `@hono/node-server`, TypeScript, `better-sqlite3`.
  No cosheaf-side password hashing — the bearer token is the credential.
- **Web**: Server-rendered Hono pages with narrowly scoped React/Vite islands
  in `src/cosheaf/web-*.tsx?`.
- **Editor**: `@chaoxu/coflat` from a sibling checkout or public
  package; do not vendor it back into this repo.
- **Document format**: Pandoc-flavored markdown per Coflat's canonical
  `FORMAT.md`; Cosheaf's local `FORMAT.md` is only host-specific notes. YAML
  frontmatter for `id`, `title`, `type`, `status`, `target`.
- **Package manager**: pnpm.

## Project layout

```
server/
  index.ts        # Hono entrypoint, routes mounted under /api
  db.ts           # config + better-sqlite3 instance
  schema.sql      # full DB schema (executed on every startup; CREATE IF NOT EXISTS)
  users.ts        # minimal `User` type ({username}); identity comes from Forgejo
  middleware.ts   # requireAuth (Bearer PAT), requireMembership() on /:owner/:repo routes
  frontmatter.ts  # parse/serialize YAML frontmatter
  indexer.ts      # indexPage(): parse → upsert doc_map → reindex backlinks/tags/FTS
  forgejo.ts      # minimal Forgejo REST client
  workspace-provisioning.ts # shared repo/workspace setup and reindex helpers
  cli.ts          # `pnpm cli` user/workspace/seed/reindex commands
  routes/
    auth.ts        # login/logout/me
    workspaces.ts  # list/create workspaces + repo member management
    files.ts       # tree/file get/put/delete, search, backlinks, validation
    pulls.ts       # pull request + review API (merge, reviews, comments, pending reviews, settings)
    branches.ts    # branch list/create/delete
    issues.ts      # issue UI projections, comments, timeline, dependencies
    notifications.ts # notification feed
    webhooks.ts    # Forgejo webhook reconciliation
src/cosheaf/
  web-editor.tsx  # page-owned rich editor island
  web-reader.ts   # page-owned Coflat reader hydration island
  editor.tsx      # MarkdownEditor wrapper around @chaoxu/coflat
  api.ts          # small cookie-auth fetch client for page islands
data/             # default COSHEAF_DATA_DIR; db.sqlite sidecar
```

## Commands

```bash
cd ..
git clone https://github.com/chaoxu/coflat.git coflat  # if ../coflat is not present
git -C coflat checkout 9e0336bc6691066d54c25057904fb1a8fe771aaf
cd cosheaf
pnpm setup:deps              # verify and build pinned sibling ../coflat
pnpm install
cp .env.example .env.dev
pnpm setup:dev              # seed local chao / Flushing Coin / Hello fixture
pnpm dev                  # Vite dev server for page islands on :5173
pnpm server               # tsx watch on server/index.ts (port 3030 by default)
pnpm dev:all              # API + Vite together with URL banner
pnpm smoke                # headless browser smoke test; defaults to setup:dev fixture
pnpm dev:worktree -- <name> [--base origin/main --fetch]
pnpm merge-task -- --branch <worker-branch> --check "rtk pnpm test"
pnpm issue -- mine
pnpm cli user add <name>  # create a user (interactive password prompt)
pnpm cli seed --user <name> --password <pw> --workspace <owner>/<repo> --workspace-name <name>
pnpm cli workspace member <owner>/<repo> <user> <admin|write|read>
pnpm cli workspace reindex <owner>/<repo>   # rebuild page index from Forgejo main
pnpm typecheck            # tsc --noEmit (root)
pnpm typecheck:server     # tsc --noEmit -p server/tsconfig.json
pnpm check:types          # both
pnpm check:lint           # bare-catch + boundary lints + biome
pnpm check:static         # lint + types + knip (unused)
pnpm check:pre-push       # fast local gate (run by lefthook)
pnpm check:stability      # unit/API tests + browser smoke flows
pnpm test                 # vitest
pnpm build                # vite build
```

## DevX quick map

Use `docs/DEVX.md` when you need the shortest path to a route owner,
verification command, or browser login-state helper.

Fast gates:

- `pnpm check:local` — static checks, unit tests, Vite build, and server build.
- `pnpm check:web` — server-rendered web end-to-end flow; requires `pnpm dev:all`.
- `pnpm check:web:settings` — focused account/repository settings E2E; requires `pnpm dev:all`.
- `pnpm dev:login-state` — writes `.playwright/cosheaf-chao-state.json` for local manual browser scripts; requires `pnpm dev:all`.

Route owner map:

- `server/routes/web.ts` — web route assembler: login/logout/home/account plus
  ordered register calls into the page modules below (registration order is
  load-bearing for Hono matching; keep it).
- `server/routes/web-context.ts` — web auth/repo resolution, shared parsers,
  error pages, href/format helpers.
- `server/routes/web-page.ts` — repoPage shell + sidebar tabs, label chips,
  user preferences fragments.
- `server/routes/web-markdown.ts` — markdown/Coflat rendering surfaces.
- `server/routes/web-thread.ts` — shared issue+pull thread machinery: layout
  with metadata rail, edit pages, timelines, review panels.
- `server/routes/web-files.ts` — tree/src/raw/_edit pages plus branches and
  commit pages.
- `server/routes/web-issues.ts` / `web-pulls.ts` / `web-chat-pages.ts` /
  `web-activity.ts` / `web-settings.ts` — the corresponding page routes
  (pull diff machinery lives with web-pulls).
- `server/routes/web-shell.ts` — app shell: full-viewport frame, left sidebar,
  bottom status bar (with the editor status slot), and Vite island asset tags.
- `public/cosheaf-web.css` — server-rendered chrome CSS only; Coflat documents
  own their rendering (see the boundary comment at the top of the file). The
  app is a fixed-frame layout: the window never scrolls, `.app-content` does.
- `server/app.ts` — app assembly, static assets, Vite/dev asset proxy, and route mounting.
- `server/index.ts` — runtime startup (`loadConfig`, DB, admin Forgejo client, `serve`).
- `src/cosheaf/web-editor.tsx` — page editor island.
- `src/cosheaf/web-reader.ts` — Coflat reader hydration island.
- `server/routes/files.ts` — typed file/tree/search/backlink API.
- `server/routes/pulls.ts` — typed pull/review/merge API.
- `server/routes/issues.ts` — typed issue/comment/timeline/activity API.
- `server/activity-feed.ts` — activity normalization and noisy edit-branch collapse.
- `shared/issues.ts` — shared issue/activity DTOs.

## DevX and automation conventions

- Use Commander for CLI argument parsing. Do not add new hand-rolled
  `process.argv` flag scanners; expose parser-normalization functions for unit
  tests when scripts have validation worth testing.
- Deployment workloads should be Docker Compose services. Avoid one-off
  `docker run` service definitions for long-running environments; put ports,
  labels, volumes, healthchecks, and environment contracts in Compose files.
- Keep preview slug, port allocation, and cleanup state in
  `scripts/preview-state.mjs`. Do not duplicate slug/port JSON handling inside
  shell snippets.
- Browser smoke checks should run through Playwright's test runner. Tiny
  wrappers may delegate to existing scripts during migration, but package
  scripts and E2E entrypoints should use `playwright test` and the shared
  `scripts/smoke-manifest.mjs` matrix.
- Use well-known libraries for standard work: Commander for CLI parsing,
  Docker Compose for container orchestration, Playwright Test for browser
  flows, DOMPurify/DOM APIs for sanitized HTML transforms, and package-exported
  types/manifests from `@chaoxu/coflat`.
- When transforming rendered HTML, sanitize to DOM and traverse nodes
  (`DocumentFragment`, `TreeWalker`, `querySelectorAll`). Do not regex over
  HTML strings except for narrow tests or pre-HTML source text.
- Do not mirror `@chaoxu/coflat` host API types, outline types, or theme
  manifests in Cosheaf. Import the exported package contracts directly and keep
  Forgejo-passthrough editor adapters structurally compatible with those
  contracts.

## Local Forgejo

Cosheaf's local Forgejo is `http://127.0.0.1:3002`.

`pnpm dev` and `pnpm server` are separate; `pnpm dev:all` runs both. Vite
proxies `/api/*` to the server (see `vite.config.ts`).

## Data model

- `doc_map(workspace_slug, cosheaf_id, forgejo_id, title, created_at)` — pages only.
- `backlinks(workspace_slug, src_id, src_path, target_id, target_label, line)`
- `xref_targets(workspace_slug, target_id, source_path, kind, display_label, line)` — rebuildable Coflat heading/equation/block labels for cross-file `[@...]` resolution.
- `notes_fts` — FTS5 virtual table over title + body, keyed by `workspace_slug`.
- `page_tags(workspace_slug, cosheaf_id, tag)`
- `webhook_log(delivery_id, delivered_at, event_type)` — coflat-only dedupe.
- `issue_claims(id, workspace_slug, issue_number, runner_name, purpose, holder_username, created_at, heartbeat_at, expires_at)` — optional live-work leases (#95). Ephemeral coordination state with no Forgejo source; rows expire and are disposable (like `webhook_log`). NOT durable knowledge — issues/PRs stay the only durable state on Forgejo.

`workspace_slug` column values are the Forgejo `owner/repo` full name
(`workspaceSlug(owner, repo)` in `shared/conventions.ts` builds it;
`parseWorkspaceSlug` splits it).

There is no `users`, `sessions`, or `workspaces` table (#63, #62). Identity
comes from a Forgejo PAT sent as `Authorization: Bearer <token>` by API clients
or as the `cosheaf_pat` HttpOnly cookie by server-rendered pages; workspace
identity is the Forgejo `(owner, repo)` pair — the same repo name under
different owners is a different workspace; the workspace's markdown format
lives in a Forgejo repo topic (`cosheaf-format-coflat` or
`cosheaf-format-forgejo-passthrough`). Workspace role (`admin | write |
read`) is resolved from Forgejo's collaborator-permission API on each
request, cached in-process for 30s; the bearer→username and
(owner, repo)→format mappings are cached on the same TTL. There is no
`memberships` table and no sidecar `branches` table — branches and pull
requests live entirely on Forgejo and are queried on demand.

## Branch and pull request lifecycle

```
branch without PR ──open PR──▶ pull request ──approve/merge──▶ merged
                                  ▲
                                  └──request changes, push more commits

branch deleted or PR closed unmerged ──▶ closed/discarded
```

- Edits are stored on Forgejo branches.
- Opening a pull request submits a branch for review.
- Admins can merge when Forgejo branch protection allows it; any
  write-access collaborator can approve or request changes through the
  Forgejo review API.
- Requesting changes keeps the pull request and branch open for more commits.
  Closing is the terminal non-merge path.
- Webhooks reconcile Forgejo PR/review/file state into SQLite and notify open
  browsers over SSE.

## Conventions

- ES modules, TypeScript strict. No CommonJS. No `any` (use `unknown`).
- Files: kebab-case. Types: PascalCase. Functions: camelCase.
- Tests next to source (`foo.ts` → `foo.test.ts`); Vitest.
- Server code uses `.js` import suffixes (NodeNext resolution).
- Don't add bare `catch {}` — `scripts/check-bare-catch.mjs` will fail.
- Don't bypass `requireAuth` / `requireMembership` on workspace routes.
- Route code must use Forgejo path helpers and existing validation when touching
  workspace files; never concatenate unvalidated user paths into API URLs.

### Naming conventions

- **snake_case in SQLite rows + stable JSON wire shapes.**
  `workspace_slug`, `cosheaf_id`, `forgejo_id`, `default_md_format`,
  `created_at`, `updated_at`, `author_username`. Shared interfaces in
  `shared/` use snake_case for fields that round-trip through SQL rows
  or the JSON wire format. API clients consume them as-received.
- **camelCase in middleware-internal types and function parameters.**
  `WorkspaceContext.defaultMdFormat`, function args like `cosheafId`,
  `forgejoId`, `workspaceSlug`.
- **PR-related types use the `Pr` prefix.** `PrMeta`, `PrState`, `PrFile`,
  `PrFiles`, `PrFileStatus`. Functions named to match (`prMeta`,
  `parsePr`, `listPrFiles`). Route filenames and URL segments stay
  `pulls` to match Forgejo's REST path.
- **`role` is `Role` in `WorkspaceContext` and `Role | "none"` in
  permission-cache entries.** `"none"` is the documented sentinel for
  "workspace exists; the user has no role on it" and is bounded at the
  middleware layer — callers downstream see `Role`.
- **Forgejo's `user.login` field is `author_username` in cosheaf shapes.**
  Not `author`, not `author_login`. One canonical name for "the Forgejo
  username of whoever did this thing."

## When changing the document model

If you change document types, statuses, link extraction, or workflow
transitions, you usually need to touch in lockstep:

1. `server/schema.sql` (CHECK constraints)
2. `server/indexer.ts` (page indexing, links, tags, FTS)
3. `server/routes/pulls.ts`, `server/routes/branches.ts`, and `server/routes/webhooks.ts`
4. `src/cosheaf/api.ts` (mirrored API types)
5. UI in `server/routes/web.ts` and page islands if state gates a new affordance

Add a test under `server/*.test.ts` (or `tests/`) for any new transition.

## Reindexing and external edits

Forgejo `main` is authoritative. Push/webhook events re-index changed markdown
files and notify clients via `/api/v1/repos/:owner/:repo/events`. After webhook
downtime or bulk repo changes, run `pnpm cli workspace reindex <owner>/<repo>`
to rebuild the page index from Forgejo's `main` tree and remove stale sidecar
rows.

## Document format

See Coflat's `FORMAT.md` for the canonical Pandoc-flavored markdown spec.
Cosheaf's local `FORMAT.md` records only host-specific behavior. Cosheaf
links recognized by the indexer:

- `[@id]` — Pandoc cross-ref / citation
- `[text](relative/path.md[#fragment])` — markdown link to another page

Bare URLs, raw HTML, and indented code blocks are intentionally out of scope.

### Workspace markdown formats

Workspaces declare one markdown format via a Forgejo repo topic:
`cosheaf-format-coflat` or `cosheaf-format-forgejo-passthrough`. The
presence of `cosheaf-format-<id>` selects the format; absence falls back
to `forgejo-passthrough` (Forgejo Markdown). Development fixtures that
need Coflat behavior explicitly set the topic via `--default-md-format
coflat` at seed time.

Discovery is topic-agnostic: cosheaf is a frontend over the forge, so the
home page and `GET /api/v1/workspaces` list **every** repo the caller's PAT
can access (`Forgejo.searchAllAccessibleRepos`), not only `cosheaf-format-*`
tagged repos. An untagged repo opens as a `forgejo-passthrough` workspace.
The format topic therefore only selects rendering/indexing behavior, never
visibility. Cosheaf-minted login PATs carry `write:user` and
`write:organization` (alongside repo/issue/notification scopes) so the user
can create and delete repos through cosheaf; if you change the scope set,
existing `login_tokens` rows must be cleared so they re-mint.

- `forgejo-passthrough`: plain `.md` files rendered through Forgejo's
  repo-scoped `/markdown` API. It preserves YAML frontmatter but extracts no
  backlinks; rich rendered diffs are unavailable and the review UI falls back
  to source diffs.
- `coflat`: Coflat-flavored markdown using `@chaoxu/coflat` parser and
  reader. Coflat-only features include `[@id]` backlinks, bare-ref rewriting
  for issue/page references, and source-line-attributed rich diffs.

Generic YAML frontmatter parsing lives in `shared/frontmatter-yaml.ts`; do not
hide generic frontmatter behavior behind one format implementation. Server
format implementations are registered in `server/format-registry.ts`.

Every server-rendered markdown render surface should be checked when changing formats:
issue bodies, issue comments, PR descriptions, PR review comments, label and
milestone descriptions, notification previews, page editor/viewer content, and
PR file diffs. Rendered HTML inserted into the DOM must pass through DOMPurify.
Do not add rendered-HTML caching unless measured Forgejo `/markdown` latency
becomes a real bottleneck.

## Things this repo is NOT

- It is not the coflat editor. The editor is a sibling package
  (`@chaoxu/coflat`); see its own repo for editor-internal debug
  helpers, browser harness, perf scripts, etc. None of `__cmView`,
  `__cmDebug`, `pnpm test:browser`, `pnpm chrome`, `scripts/perf-*` apply
  here.
- It is not a math-native semantic engine or an agent system. No theorem graph,
  proof dependency model, proving, exploration, gatherer/oracle logic, or
  verifier-bot implementation belongs in this repo. The optional chat launcher
  only hands an issue-backed thread to a separate layer, which talks to
  cosheaf over the same HTTP API a human uses.
