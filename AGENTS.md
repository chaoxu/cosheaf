# Cosheaf

Human-usable knowledge base for Coflat-flavored markdown. Forgejo repositories
hold the canonical markdown files, branches, pull requests, reviews, and issues;
SQLite is a derived, rebuildable sidecar index for fast reads, sessions,
memberships, and local auth state.

The long-term direction is a thin knowledge-base UI over a Forgejo/Gitea-style
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
separate layer and participate as ordinary verifier/member users over the same
HTTP API. Keep cosheaf's surface usable without any automation.

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
  links, FTS index, branch/PR cache metadata, memberships, and sessions/tokens. The
  page index is rebuildable from Forgejo via `pnpm cli workspace reindex <slug>`.
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
  work in progress; keep local branch ids only as transitional/cache details.
- Make review pull-request-native: prefer PR numbers, head/base branches,
  review states, review comments, and Forgejo merge behavior over change-centric
  Cosheaf vocabulary.
- Keep the issue board close to Forgejo issues: labels, milestones, pinned
  state, dependencies/blocks, comments, and timeline should be mediated only
  where Cosheaf adds knowledge-base rendering or links.
- Keep API shapes Forgejo-like where possible (`/branches`, `/pulls`,
  `/issues`, file contents) and mark older compatibility wrappers as
  transitional when replacing them.
- Treat webhooks and repair/reindex commands as the reconciliation path from
  Forgejo into SQLite.

Forgejo-only: Gitea is not a supported target. Don't add Gitea-compatibility
hedging or version-sensitivity caveats; assume Forgejo behavior.

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
    changes.ts     # branch / pull request / review API (filename is legacy; routes use branch/PR vocab)
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
- `doc_map(workspace_id, cosheaf_id, doc_type, forgejo_kind, forgejo_id, title)`
- `backlinks(workspace_id, src_id, src_path, target_id, target_label)`
- `notes_fts` — FTS5 virtual table over title + body
- `page_tags(workspace_id, cosheaf_id, tag)`
- `branches(id, workspace_id, author_user_id, branch_name, state, pr_number, base_sha, title)` —
  sidecar rows for the branch / pull-request workflow. Pre-existing dev DBs
  with a legacy `changes` table are migrated in-place on startup (see
  `renameChangesTable` in `server/db.ts`).
- `webhook_log(delivery_id, delivered_at, event_type)`

## Branch and pull request lifecycle

```
branch without PR ──open PR──▶ pull request ──approve/merge──▶ merged
                                  ▲
                                  └──request changes, push more commits

branch deleted or PR closed unmerged ──▶ closed/discarded
```

- Edits are stored on Forgejo branches.
- Opening a pull request submits a branch for review.
- Owners can merge when Forgejo branch protection allows it; verifiers approve
  or request changes through the same API surface.
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
- It is not a math-native semantic engine or an agent system. No theorem graph,
  proof dependency model, proving, exploration, or verifier-bot logic belongs
  in this repo. That goes in a separate layer, talking to cosheaf over the same
  HTTP API a human uses.
