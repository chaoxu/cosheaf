# Cosheaf

Human-usable knowledge base for Coflat-flavored markdown. Forgejo repositories
hold the canonical markdown files, branches, pull requests, reviews, issues,
and collaborator memberships; SQLite is a derived, rebuildable sidecar index
for fast reads, sessions, and local auth state.

The long-term direction is a thin knowledge-base UI over a Forgejo-style
forge. Cosheaf should feel like a focused repository interface with custom
Coflat rendering and indexing, not a separate CMS with its own workflow model.
When adding features, prefer a direct mapping to Forgejo concepts and APIs
before inventing a Cosheaf-specific abstraction.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is math-friendly. Still, Cosheaf is page-oriented rather than
math-native: do not add theorem graphs, proof dependency models, or other
semantic math layers unless explicitly requested.

Coflat markdown is one of the document formats cosheaf supports, and currently
the only one. The codebase carries a `DocumentFormat` seam
(`server/document-format/`, `src/cosheaf/document-format/`) so additional
formats can be added cleanly later; touch that seam through the
`coflatMarkdownFormat` singleton rather than reaching into its internals.
Don't add a second format until one is asked for.

Agents (autoprover and friends) are out of scope here. They will live in a
separate layer and participate as ordinary Forgejo write-access collaborators
over the same HTTP API. Keep cosheaf's surface usable without any automation.

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
  links, FTS index, local auth state, workspace-to-repo mappings, webhook
  dedupe, and passthrough audit logs. Memberships, branches, pull requests,
  issues, labels, milestones, and notifications live on Forgejo and are read
  on demand. The page index is rebuildable from Forgejo via
  `pnpm cli workspace reindex <slug>`.
- **Stable identity via frontmatter.** Every page has an `id` in its YAML
  frontmatter. The indexer records missing ids in SQLite; canonical writes can
  add frontmatter before persisting content.
- **Workflow as trust, not automation.** Branches, pull requests, reviews, and
  merges are the same whether the proposer is a human or a bot.

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
- Review/simplify checklist for Forgejo-shell issues: prefer direct Forgejo
  concepts and APIs; use passthrough for 1:1 Forgejo operations; keep typed
  routes only where Cosheaf adds document/index behavior, validation, SSE, or
  UI response shaping; delete old token and wrapper language as the
  Forgejo-native path lands.

Forgejo-only: Gitea is not a supported target. Don't add Gitea-compatibility
hedging or version-sensitivity caveats; assume Forgejo behavior.

### Agent API and typed routes

Cosheaf exposes two HTTP surfaces. Agents should start with the Forgejo
passthrough API for ordinary Forgejo operations, and use typed routes only when
they need Cosheaf behavior on top of Forgejo.

- **Forgejo passthrough** (`/api/v1/w/:slug/forgejo/*`) is the **agent
  default**. Forgejo-trained bots reach Forgejo through it with direct
  `Authorization: Bearer <Forgejo PAT>` auth; Cosheaf validates the PAT,
  enforces workspace scoping, and audits every call in
  `forgejo_passthrough_log`. Use it first for branch, pull request, issue,
  comment, label, milestone, review, notification, and file-content operations
  that are naturally Forgejo-shaped.
- **Typed routes** (`routes/pulls.ts`, `routes/issues.ts`, `routes/files.ts`,
  `routes/branches.ts`, `routes/notifications.ts`) are for the SPA and for
  Cosheaf-specific behavior. Keep or add them when a route needs validation,
  response shaping, sidecar integration, SSE events, or Cosheaf-specific gates
  (e.g. `requireAdminFresh` on merge).

Typed routes remain recommended for Cosheaf document/index behavior:

- Use `routes/files.ts` for page reads/writes that should synchronously apply
  Coflat frontmatter/id handling, path validation, index updates, backlinks,
  FTS, and browser events.
- Use typed search, backlinks, document-list, and event routes when callers
  need the SQLite sidecar index rather than raw Forgejo repository contents.
- Use typed merge/admin routes where Cosheaf adds freshness checks or other
  UI safety gates before calling Forgejo.

File-write boundary: a Markdown write through the Forgejo contents API,
including via passthrough, is an external repository write from Cosheaf's point
of view. Webhooks and `pnpm cli workspace reindex <slug>` reconcile those
writes into SQLite. A Markdown write that needs immediate Cosheaf
frontmatter/index/SSE behavior should go through the typed file route.

Examples for agents using a Forgejo PAT:

- `GET /api/v1/w/flushing-coin/forgejo/issues?state=open`
- `PATCH /api/v1/w/flushing-coin/forgejo/issues/42` with `{ "state": "closed" }`
- `GET /api/v1/w/flushing-coin/forgejo/pulls?state=open`
- `GET /api/v1/w/flushing-coin/forgejo/labels`
- `GET /api/v1/w/flushing-coin/forgejo/milestones?state=open`
- `GET /api/v1/w/flushing-coin/forgejo/contents/hello.md`
- `GET /api/v1/w/flushing-coin/forgejo/notifications?status=unread`

Use `Authorization: Bearer <Forgejo PAT>` on these Cosheaf requests; Cosheaf
translates that to the Forgejo token auth header after validating workspace
membership.

Rules of thumb:

- Don't add a typed wrapper that's a 1:1 Forgejo proxy with no logic — the
  SPA or agent can fetch through passthrough instead.
- Don't expose a path through passthrough when a typed route guards it
  (e.g. `pulls/:n/merge` is forbidden in passthrough because the typed
  route runs `requireAdminFresh`).
- Don't mirror Forgejo state into SQLite just to filter on it; Forgejo's
  repo-scoped filters (`assigned_by`, `created_by`, `state`, `q`) are
  what the typed routes should compose.

Do not rewrite the app, build a generic CMS, add arbitrary document-format
plugins, or move agent/prover logic into this repo as part of this direction.

## Stack

- **Server**: Hono on `@hono/node-server`, TypeScript, `better-sqlite3`,
  `@node-rs/argon2` for password hashing.
- **Client**: React 19 + Vite, single-page app in `src/cosheaf/app.tsx`.
- **Editor**: `@chaoxu/coflat-editor` (published package; do not vendor it
  back into this repo).
- **Document format**: Pandoc-flavored markdown per `FORMAT.md`. YAML
  frontmatter for `id`, `title`, `type`, `status`, `target`.
- **Package manager**: pnpm.

## Project layout

```
server/
  index.ts        # Hono entrypoint, routes mounted under /api
  db.ts           # config + better-sqlite3 instance
  schema.sql      # full DB schema (executed on every startup; CREATE IF NOT EXISTS)
  users.ts        # users, sessions, argon2 hashing, Forgejo PAT-backed auth
  middleware.ts   # requireAuth, requireMembership(slug)
  frontmatter.ts  # parse/serialize YAML frontmatter
  indexer.ts      # indexPage(): parse → upsert doc_map → reindex backlinks/tags/FTS
  forgejo.ts      # minimal Forgejo REST client
  workspace-provisioning.ts # shared repo/workspace setup and reindex helpers
  cli.ts          # `pnpm cli` user/workspace/seed/reindex commands
  routes/
    auth.ts        # login/logout/me
    workspaces.ts  # list/create workspaces
    files.ts       # tree/file get/put/delete, search, backlinks, validation
    pulls.ts       # pull request + review API (merge, reviews, comments, pending reviews, settings)
    branches.ts    # branch list/create/delete
    issues.ts      # issue UI projections, comments, timeline, dependencies
    notifications.ts # notification feed
    forgejo-passthrough.ts # /forgejo/* agent escape hatch (audited)
    webhooks.ts    # Forgejo webhook reconciliation
src/cosheaf/
  main.tsx        # React entry
  app.tsx         # full single-file UI (sidebar, editor, pull requests, issues, backlinks)
  editor.tsx      # MarkdownEditor wrapper around @chaoxu/coflat-editor
  api.ts          # typed fetch client mirroring server routes
data/             # default COSHEAF_DATA_DIR; db.sqlite sidecar
```

## Commands

```bash
pnpm install
cp .env.example .env.dev
pnpm setup:dev              # seed local chao / Flushing Coin / Hello fixture
pnpm dev                  # Vite dev server (frontend) on :5173
pnpm server               # tsx watch on server/index.ts (port 3030 by default)
pnpm dev:all              # API + Vite together with URL banner
pnpm smoke                # headless browser smoke test; defaults to setup:dev fixture
pnpm dev:worktree -- <name> [--base origin/main --fetch]
pnpm merge-task -- --branch <worker-branch> --check "rtk pnpm test"
pnpm issue -- mine
pnpm cli user add <name>  # create a user (interactive password prompt)
pnpm cli seed --user <name> --password <pw> --workspace <slug> --workspace-name <name>
pnpm cli workspace member <slug> <user> <admin|write|read>
pnpm cli workspace reindex <slug>   # rebuild page index from Forgejo main
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

## Local Forgejo

Cosheaf's local Forgejo is `http://127.0.0.1:3002` with data/config under
`/opt/homebrew/var/forgejo`. Do not use the unrelated Gitea instance on
`http://127.0.0.1:3001` for Cosheaf.

`pnpm dev` and `pnpm server` are separate; `pnpm dev:all` runs both. Vite
proxies `/api/*` to the server (see `vite.config.ts`).

## Data model

- `users(id, username, forgejo_token_ciphertext, created_at)`
- `sessions(id, user_id, expires_at)` — cookie sessions
- `workspaces(id, slug, name, forgejo_repo)` — one Forgejo repo per workspace
- `doc_map(workspace_id, cosheaf_id, forgejo_id, title, created_at)` — pages only; the prior polymorphic `doc_type`/`forgejo_kind` columns were dropped.
- `backlinks(workspace_id, src_id, src_path, target_id, target_label)`
- `notes_fts` — FTS5 virtual table over title + body
- `page_tags(workspace_id, cosheaf_id, tag)`
- `webhook_log(delivery_id, delivered_at, event_type)`

Workspace role (`admin | write | read`) is resolved from Forgejo's
collaborator-permission API on each request, cached in-process for 30s.
There is no SQLite `memberships` table. There is no sidecar `branches`
table either — branches and pull requests live entirely on Forgejo and
are queried on demand via `/branches/mine` and `/pulls`.

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

## When changing the document model

If you change document types, statuses, link extraction, or workflow
transitions, you usually need to touch in lockstep:

1. `server/schema.sql` (CHECK constraints)
2. `server/indexer.ts` (page indexing, links, tags, FTS)
3. `server/routes/pulls.ts`, `server/routes/branches.ts`, and `server/routes/webhooks.ts`
4. `src/cosheaf/api.ts` (mirrored API types)
5. UI in `src/cosheaf/app.tsx` if state gates a new affordance

Add a test under `server/*.test.ts` (or `tests/`) for any new transition.

## Reindexing and external edits

Forgejo `main` is authoritative. Push/webhook events re-index changed markdown
files and notify clients via `/api/v1/w/:slug/events`. After webhook downtime
or bulk repo changes, run `pnpm cli workspace reindex <slug>` to rebuild the
page index from Forgejo's `main` tree and remove stale sidecar rows.

## Document format

See `FORMAT.md` for the canonical Pandoc-flavored markdown spec. Cosheaf
links recognized by the indexer:

- `[@id]` — Pandoc cross-ref / citation
- `[text](relative/path.md[#fragment])` — markdown link to another page

Bare URLs, raw HTML, and indented code blocks are intentionally out of scope.

## Things this repo is NOT

- It is not the coflat editor. The editor is a published package
  (`@chaoxu/coflat-editor`); see its own repo for editor-internal debug
  helpers, browser harness, perf scripts, etc. None of `__cmView`,
  `__cmDebug`, `pnpm test:browser`, `pnpm chrome`, `scripts/perf-*` apply
  here.
- It is not a math-native semantic engine or an agent system. No theorem graph,
  proof dependency model, proving, exploration, or verifier-bot logic belongs
  in this repo. That goes in a separate layer, talking to cosheaf over the same
  HTTP API a human uses.
