# Cosheaf

Human-usable mathematical knowledge base. Plain markdown files on disk are the
source of truth; SQLite is a derived, rebuildable index over them. Cosheaf
also owns the document **lifecycle**: pages, proposed edits, reviews,
approvals, and trusted ("golden") status.

Agents (autoprover and friends) are out of scope here. They will live in a
separate layer and participate as ordinary verifier/member users over the same
HTTP API. Keep cosheaf's surface usable without any automation.

## Shared file

`AGENTS.md` is the canonical shared instructions file for both `AGENTS.md` and
`CLAUDE.md` (the latter is a symlink). Update one and the other follows.

## Core principles

- **Plain files are source of truth.** Every page, proposal, and review is a
  `.md` file under `data/workspaces/<slug>/`. Humans can edit them directly
  with any editor; cosheaf will reconcile.
- **No hidden database-only knowledge.** SQLite stores document metadata,
  links, FTS index, approvals, and sessions/tokens — all rebuildable from the
  files (except auth state). `pnpm cli workspace reindex <slug>` rebuilds from
  disk.
- **Stable identity via frontmatter.** Every page has an `id` in its YAML
  frontmatter. The indexer auto-fills missing ids and rewrites the file
  canonically.
- **Workflow as trust, not automation.** `proposal → review → approve/reject
  → promote` is the same whether the proposer is a human or a bot.
- **One concept, one owner.** A document's status lives in its frontmatter and
  is mirrored to SQLite by `indexDocument`. Approvals live only in SQLite
  (they're per-user records, not document content).

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
  db.ts           # config + better-sqlite3 instance + workspaceDir()
  schema.sql      # full DB schema (executed on every startup; CREATE IF NOT EXISTS)
  auth.ts         # users, sessions, tokens, argon2 hashing
  middleware.ts   # requireAuth, requireMembership(slug)
  frontmatter.ts  # parse/serialize YAML frontmatter
  indexer.ts      # indexDocument(): parse → upsert → reindex links + FTS
  links.ts        # extract [[id]], [@id], [text](path.md) → links table; getBacklinks()
  workflow.ts     # submit, approve, reject, createProposal, getReviewQueue, promote
  cli.ts          # `pnpm cli` user/workspace/reindex commands
  routes/
    auth.ts        # login/logout/me
    tokens.ts      # personal API tokens
    workspaces.ts  # list/create workspaces
    notes.ts       # tree/note get/put/delete, search, backlinks, documents list
    workflow.ts    # queue, settings, proposal, submit, approve, reject
src/cosheaf/
  main.tsx        # React entry
  app.tsx         # full single-file UI (sidebar, editor, queue, propose, backlinks)
  editor.tsx      # MarkdownEditor wrapper around @chaoxu/coflat-editor
  api.ts          # typed fetch client mirroring server routes
data/             # default COSHEAF_DATA_DIR; db.sqlite + workspaces/<slug>/...
```

## Commands

```bash
pnpm install
pnpm dev                  # Vite dev server (frontend) on :5173
pnpm server               # tsx watch on server/index.ts (port 3000 by default)
pnpm cli user add <name>  # create a user (interactive password prompt)
pnpm cli workspace add <slug> <name> --owner <user>
pnpm cli workspace member <slug> <user> <owner|verifier|member>
pnpm cli workspace reindex <slug>   # rebuild SQLite index from disk
pnpm typecheck            # tsc --noEmit (root)
pnpm typecheck:server     # tsc --noEmit -p server/tsconfig.json
pnpm check:types          # both
pnpm check:lint           # bare-catch + boundary lints + biome
pnpm check:static         # lint + types + knip (unused)
pnpm check:pre-push       # fast local gate (run by lefthook)
pnpm test                 # vitest
pnpm build                # vite build
```

`pnpm dev` and `pnpm server` are separate; in development run both. Vite
proxies `/api/*` to the server (see `vite.config.ts`).

## Data model

- `users(id, username, password_hash, created_at)`
- `sessions(id, user_id, expires_at)` — cookie sessions
- `tokens(id, user_id, name, token_hash)` — personal API tokens (`Bearer cs_…`)
- `workspaces(id, slug, name)` — one filesystem root per workspace
- `memberships(workspace_id, user_id, role)` — role ∈ `owner | verifier | member`
- `documents(workspace_id, id, path, type, status, target_id, title, mtime)`
  - `type ∈ {page, proposal, review}`
  - `status ∈ {draft, unreviewed, golden, rejected, archived}`
  - `target_id` points to the page a proposal/review targets
- `links(workspace_id, src_id, target_id, target_label)` — drives backlinks
- `notes_fts` — FTS5 virtual table over title + body
- `workspace_settings(workspace_id, min_approvals)` — promotion threshold
- `approvals(workspace_id, document_id, verifier_user_id, decision, comment, created_at)`

## Workflow lifecycle

```
draft  ──submit──▶  unreviewed  ──approve (×min_approvals)──▶  golden
                     │  ──reject──▶  rejected
proposal targeting page P:
  unreviewed ──approve──▶ promote: P.body := proposal.body, P.status := golden,
                                   proposal.status := archived
```

- `submitDocument` rewrites the file's frontmatter `status` to `unreviewed`.
- `decideOnDocument` records an `approvals` row, then either applies
  `rejected` (on reject) or — if approvals reach `min_approvals` — promotes.
- Promotion of a `proposal` overwrites the target page body. Promotion of a
  plain `page` flips its status to `golden` in place.
- All status transitions write canonical frontmatter to disk via atomic rename.

## Conventions

- ES modules, TypeScript strict. No CommonJS. No `any` (use `unknown`).
- Files: kebab-case. Types: PascalCase. Functions: camelCase.
- Tests next to source (`foo.ts` → `foo.test.ts`); Vitest.
- Server code uses `.js` import suffixes (NodeNext resolution).
- Don't add bare `catch {}` — `scripts/check-bare-catch.mjs` will fail.
- Don't bypass `requireAuth` / `requireMembership` on workspace routes.
- Atomic file writes: write to `<file>.tmp-<pid>-<ts>` then rename. See
  `notes.put` and `workflow.writeAtomic`.
- Path safety: every filesystem-touching route must `safeJoin(root, rel)` to
  block traversal.

## When changing the document model

If you change document types, statuses, link extraction, or workflow
transitions, you usually need to touch in lockstep:

1. `server/schema.sql` (CHECK constraints)
2. `server/indexer.ts` (`DOCUMENT_TYPES`, `DOCUMENT_STATUSES`)
3. `server/workflow.ts` (`DocumentRow.type`)
4. `src/cosheaf/api.ts` (mirrored `DocumentMeta` type unions)
5. UI in `src/cosheaf/app.tsx` if a status gates a new affordance

Add a test under `server/*.test.ts` (or `tests/`) for any new transition.

## Reindexing and external edits

The on-disk file is authoritative. The server runs a filesystem watcher per
workspace: external `.md` edits are re-indexed automatically and the client
is notified via the per-workspace SSE stream at `/api/w/:slug/events`. After
bulk external changes (or if the server was offline), run `pnpm cli workspace
reindex <slug>` to force a full rebuild.

## Document format

See `FORMAT.md` for the canonical Pandoc-flavored markdown spec. Cosheaf
links recognized by the indexer:

- `[[id]]` — wiki link by document id
- `[@id]` — Pandoc cross-ref / citation
- `[text](relative/path.md)` — markdown link to another page

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
