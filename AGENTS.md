# Cosheaf

Human-usable mathematical knowledge base. Forgejo repositories hold the
canonical markdown files and change workflow; SQLite is a derived, rebuildable
sidecar index for fast reads, sessions, memberships, and local auth state.

Agents (autoprover and friends) are out of scope here. They will live in a
separate layer and participate as ordinary verifier/member users over the same
HTTP API. Keep cosheaf's surface usable without any automation.

## Shared file

`AGENTS.md` is the canonical shared instructions file for both `AGENTS.md` and
`CLAUDE.md` (the latter is a symlink). Update one and the other follows.

## Core principles

- **Forgejo is source of truth.** Every page is a `.md` file on the workspace
  repo's `main` branch. Draft changes live on `change/<id>` branches and move
  through Forgejo pull requests.
- **No hidden database-only knowledge.** SQLite stores document metadata,
  links, FTS index, change metadata, memberships, and sessions/tokens. The
  page index is rebuildable from Forgejo via `pnpm cli workspace reindex <slug>`.
- **Stable identity via frontmatter.** Every page has an `id` in its YAML
  frontmatter. The indexer records missing ids in SQLite; canonical writes can
  add frontmatter before persisting content.
- **Workflow as trust, not automation.** `draft → review → merged` and
  `review → changes_requested → review` are the same whether the proposer is a
  human or a bot.

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
  users.ts        # users, sessions, tokens, argon2 hashing, Forgejo proxy users
  middleware.ts   # requireAuth, requireMembership(slug)
  frontmatter.ts  # parse/serialize YAML frontmatter
  indexer.ts      # indexPage(): parse → upsert doc_map → reindex backlinks/tags/FTS
  forgejo.ts      # minimal Forgejo REST client
  workspace-provisioning.ts # shared repo/workspace setup and reindex helpers
  cli.ts          # `pnpm cli` user/workspace/seed/reindex commands
  routes/
    auth.ts        # login/logout/me
    tokens.ts      # personal API tokens
    workspaces.ts  # list/create workspaces
    files.ts       # tree/file get/put/delete, search, backlinks, documents list
    changes.ts     # draft changes, publish, review, request changes, close
    webhooks.ts    # Forgejo webhook reconciliation
src/cosheaf/
  main.tsx        # React entry
  app.tsx         # full single-file UI (sidebar, editor, queue, propose, backlinks)
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
pnpm cli workspace member <slug> <user> <owner|verifier|member>
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

- `users(id, username, password_hash, forgejo_username, created_at)`
- `sessions(id, user_id, expires_at)` — cookie sessions
- `tokens(id, user_id, name, token_hash)` — personal API tokens (`Bearer cs_…`)
- `workspaces(id, slug, name, forgejo_repo)` — one Forgejo repo per workspace
- `memberships(workspace_id, user_id, role)` — role ∈ `owner | verifier | member`
- `doc_map(workspace_id, cosheaf_id, doc_type, forgejo_kind, forgejo_id, target_id, title, author_user_id)`
- `backlinks(workspace_id, src_id, src_path, target_id, target_label)`
- `notes_fts` — FTS5 virtual table over title + body
- `page_tags(workspace_id, cosheaf_id, tag)`
- `changes(id, workspace_id, author_user_id, branch_name, state, pr_number, base_sha, title)`
- `webhook_log(delivery_id, delivered_at, event_type)`

## Change lifecycle

```
draft ──publish──▶ review ──approve/merge──▶ merged
                    ▲
                    └──request changes──▶ changes_requested ──publish──┘

draft/review/changes_requested ──close/discard──▶ closed
```

- Draft edits are stored on `change/<id>` branches.
- Publishing opens or updates a Forgejo pull request.
- Owners can merge directly; verifiers approve or request changes through the
  same API surface.
- Requesting changes keeps the pull request and branch open for same-change
  repair. Closing is the terminal non-merge path.
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
3. `server/routes/changes.ts` and `server/routes/webhooks.ts`
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
- It is not an agent system. No proving, exploration, or verifier-bot logic
  belongs in this repo. That goes in `autoprover` later, talking to cosheaf
  over the same HTTP API a human uses.
