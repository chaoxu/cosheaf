# Cosheaf

A multi-user knowledge base built on Coflat-format markdown files. Cosheaf is
a Forgejo-native UI for trustworthy markdown authoring: pages live in Forgejo,
work happens on branches, review happens in pull requests, and merged markdown
on `main` is canonical. SQLite is only a rebuildable sidecar index.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is intentionally close to mathematical writing: theorem-style
fenced divs, KaTeX math, `[@id]` cross-references, citations, and LaTeX export
conventions. Cosheaf itself stays page-oriented; it does not maintain a
math-native theorem graph or proof dependency model.

Coflat is the current canonical document format. Supporting other markdown
profiles or document formats may make sense later, but it is not part of the
current product surface.

The substrate is fully usable by humans alone. Automated agents
(an `autoprover` layer, planned separately) participate as additional users
through the same HTTP API.

## What it gives you

- **Pages** as Coflat-flavored markdown (theorem-style fenced divs, KaTeX
  math, `[@id]` cross-references and citations — see [`FORMAT.md`](./FORMAT.md)).
- **Branch workflow** — edits live on ordinary Forgejo branches. Opening a pull
  request submits the branch for review; merging the pull request makes it
  canonical.
- **Pull request review** — owners and verifiers review pull requests through
  the Cosheaf UI/API while Forgejo remains the durable record.
- **Backlinks + FTS5 search** — Coflat's `[@id]` references are indexed; the
  body is full-text searchable.
- **External-edit safe** — Forgejo webhooks reindex changed markdown files and
  stream updates over SSE to open browsers.
- **Personal API tokens** — humans and bots authenticate via cookie session
  or `Authorization: Bearer cs_…` token.

## Quick start

```bash
pnpm install
cp .env.example .env.dev
# edit .env.dev with COSHEAF_FORGEJO_TOKEN
pnpm setup:dev
pnpm dev:all
# → http://localhost:5173
```

`dev:all` runs the API server (`:3030`) and Vite (`:5173`) together with
prefixed logs and prints the app/API URLs on startup. Vite proxies `/api/*`
to the server.

## Stack

- TypeScript end-to-end. Hono on the server, React 19 + Tailwind v4 +
  shadcn primitives in the browser, CodeMirror 6 inside `@chaoxu/coflat-editor`
  (consumed as a published package; not built here).
- SQLite via `better-sqlite3`. WAL mode. Forgejo `main` is the page source of
  truth; the DB is a rebuildable index.
- Forgejo webhooks reconcile external edits; SSE pushes changes to connected
  clients.

## Project layout

```
server/        Hono API, Forgejo client, SQLite sidecar index, change workflow
src/cosheaf/   React UI (login, workspace, file tree, editor, review surfaces)
scripts/       dev:all spawner, lefthook checks, Gitea issue + worker-branch tools
FORMAT.md      Coflat document format reference
API.md         HTTP API contract (v1) — endpoints, error codes, SSE shape
AGENTS.md      Repository conventions, commands, debug helpers
DESIGN.md      Product philosophy and trust model
```

## Commands

```bash
pnpm dev:all          # API + Vite together (recommended)
pnpm setup:dev        # Seed chao / Flushing Coin / Hello for local testing
pnpm smoke            # Headless browser smoke test against the dev fixture
pnpm server           # API only (port 3030)
pnpm dev              # Vite only
pnpm build            # Vite production build
pnpm preview          # Serve the built bundle on 0.0.0.0
pnpm test             # vitest run
pnpm check:stability  # unit/API tests plus browser open/create/publish flows
pnpm check:pre-push   # Types + lint gates (also run by lefthook on push)
pnpm cli              # See `pnpm cli` for user/workspace/seed subcommands
```

## Dev workflow helpers

```bash
pnpm dev:worktree -- <name> [--base origin/main --fetch]
pnpm merge-task -- --branch <worker-branch> --check "rtk pnpm test"
pnpm issue -- mine
pnpm issue -- verify-close <number> --commit <sha> --verify "pnpm test"
```

`dev:worktree` creates an isolated Git worktree under `.worktrees/` and links
`node_modules` when available. `merge-task` prints the fetch/rebase/check/merge
sequence for integrating worker branches. `issue` wraps the Forgejo `tea`
issue commands with the repo defaults used by this project.

See [AGENTS.md](./AGENTS.md) for full conventions and debug helpers.

## Status

Early. The substrate (auth, branch and pull request workflow, indexing, search,
reviews, and approvals) is in place and end-to-end smoke-tested. The autoprover layer is not
yet built — it lives in a separate repo and talks to Cosheaf over the HTTP API.
