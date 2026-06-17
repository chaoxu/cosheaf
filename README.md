# Cosheaf

A multi-user knowledge base built on
[Coflat](https://github.com/chaoxu/coflat)-format markdown files. Cosheaf is a
Forgejo-native UI for trustworthy markdown authoring: pages live in Forgejo,
work happens on branches, review happens in pull requests, and merged markdown
on `main` is canonical. SQLite is a sidecar for rebuildable indexes plus the
small Cosheaf-owned credential cache used by browser login.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is intentionally close to mathematical writing: theorem-style
fenced divs, KaTeX math, `[@id]` cross-references, citations, and LaTeX export
conventions. Cosheaf itself stays page-oriented; it does not maintain a
math-native theorem graph or proof dependency model.

Workspaces choose a markdown format. New workspaces default to Forgejo Markdown
passthrough for plain `.md` files, while Coflat workspaces opt into math-friendly
rendering, backlinks, and rich review diffs.

The substrate is fully usable by humans alone. Automated agents such as
[Coverify](https://github.com/chaoxu/coverify) participate as ordinary Forgejo
collaborators through Cosheaf's HTTP API. The Chat tab is an issue-backed UI
that can trigger the external Coverify harness when configured; the agent logic
itself stays outside this repo.

## What it gives you

- **Pages** as Coflat-flavored markdown (theorem-style fenced divs, KaTeX
  math, `[@id]` cross-references and citations - see
  [Coflat `FORMAT.md`](https://github.com/chaoxu/coflat/blob/main/FORMAT.md)
  and Cosheaf's [format notes](./FORMAT.md)).
- **Branch workflow** — edits live on ordinary Forgejo branches. Opening a pull
  request submits the branch for review; merging the pull request makes it
  canonical.
- **Pull request review** — admins and write collaborators review pull requests through
  the Cosheaf UI/API while Forgejo remains the durable record.
- **Backlinks + FTS5 search** — Coflat's `[@id]` references are indexed; the
  body is full-text searchable.
- **External-edit safe** — Forgejo webhooks reindex changed markdown files and
  stream updates over SSE to open browsers.
- **Cosheaf PAT auth** — API clients and agents send a PAT as
  `Authorization: Bearer <token>`. Humans sign in through cosheaf's
  server-rendered login form, which exchanges Forgejo credentials for a
  PAT-backed HttpOnly cookie.
- **Cosheaf-first agent API** — agents use typed Cosheaf workspace routes for
  branches, files, pull requests, reviews, issues, labels, milestones,
  notifications, and markdown rendering. The backing forge is an
  implementation detail, not part of the public client contract.

## API shape

Agents should use the typed Cosheaf workspace API. Cosheaf validates bearer
auth, scopes the request to the workspace, and returns stable Cosheaf response
shapes so callers do not need to know which forge backs the workspace.

Use typed routes for normal workflows: Coflat page reads/writes with
frontmatter/id handling, path validation, main-branch sidecar indexing,
backlinks, FTS search, document lists, branch creation, pull request
list/detail/open/review/merge, issue comments, labels, milestones,
notifications, markdown rendering, SSE updates, and merge/admin gates.

File writes have a clear boundary. Markdown writes made outside Cosheaf are
treated as external repo edits and reach the SQLite index through
webhook/reindex reconciliation. Branch writes through the typed file route get
immediate Cosheaf frontmatter/id behavior and SSE, while search/backlinks/doc
metadata continue to mirror `main` after the merge push webhook or reindex.

Workspaces are addressed by their Forgejo `(owner, repo)` pair. Example
agent/API calls, all with `Authorization: Bearer <token>`:
`GET /api/v1/repos/chao/flushing-coin/issues?state=open`,
`GET /api/v1/repos/chao/flushing-coin/pulls?state=open`,
`GET /api/v1/repos/chao/flushing-coin/labels`,
`GET /api/v1/repos/chao/flushing-coin/milestones?state=open`, and
`GET /api/v1/repos/chao/flushing-coin/file?path=hello.md&branch=main`.

## Quick start

```bash
cd ..
git clone https://github.com/chaoxu/coflat.git coflat  # if ../coflat is not present
git -C coflat checkout 1eae376ed1e462a40df3ff812d6930b07117b969
cd cosheaf
pnpm setup:deps  # verifies the pinned Coflat checkout, then builds it
pnpm install
cp .env.example .env.dev
# Prerequisite: a Forgejo reachable at COSHEAF_FORGEJO_URL (default :3002).
# Edit .env.dev with COSHEAF_FORGEJO_TOKEN and COSHEAF_FORGEJO_ADMIN_TOKEN —
# mint both from Forgejo (Settings → Applications → Generate New Token); see
# .env.example for the required scopes.
pnpm preflight   # checks Node, the Coflat pin, .env.dev, and Forgejo
pnpm setup:dev
pnpm dev:all
# → http://localhost:3030
```

`dev:all` runs the web/API server (`:3030`) and Vite (`:5173`) together with
prefixed logs. Open the app on `:3030`; Vite serves page-island modules in
development.

## Stack

- TypeScript end-to-end. Hono renders the durable web pages; React 19 + Vite
  power page-owned islands such as the rich editor; CodeMirror 6 lives inside
  [`@chaoxu/coflat`](https://github.com/chaoxu/coflat). For source builds
  before the package is published from a public registry, clone
  [`coflat`](https://github.com/chaoxu/coflat) next to this repo.
- Server-rendered CSS lives in `public/cosheaf-web.css`; Vite/Tailwind support
  the page islands and bundled client assets.
- SQLite via `better-sqlite3`. WAL mode. Forgejo `main` is the page source of
  truth; document/index tables are rebuildable, while `login_tokens` caches
  Cosheaf-issued Forgejo PATs for browser login reuse.
- Forgejo webhooks reconcile external edits; SSE pushes changes to connected
  clients.

## Project layout

```
server/        Hono API, Forgejo client, SQLite sidecar, pull request workflow
src/cosheaf/   Page islands for the editor/reader plus their small fetch client
scripts/       dev:all spawner, lefthook checks, Forgejo issue + worker-branch tools
FORMAT.md      Cosheaf-specific notes and pointer to the Coflat format spec
API.md         HTTP API contract (v1) — endpoints, error codes, SSE shape
AGENTS.md      Repository conventions, commands, debug helpers
DESIGN.md      Product philosophy and trust model
```

## Commands

```bash
pnpm setup:deps      # Verify and build pinned sibling ../coflat
pnpm install         # Install Cosheaf after ../coflat exists
pnpm dev:all          # web/API server + Vite page-island dev server
pnpm setup:dev        # Seed chao / Flushing Coin / Hello for local testing
pnpm smoke            # Headless browser smoke test against the dev fixture
                      # For a full manual walkthrough see SMOKE_CHECKLIST.md
pnpm server           # API only (port 3030)
pnpm dev              # Vite page-island dev server only
pnpm build            # Vite production build for page islands
pnpm preview          # Preview built island assets on 0.0.0.0
pnpm test             # vitest run
pnpm check:stability  # unit/API tests plus server-rendered browser flows
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
reviews, approvals, and issue-backed chat) is in place and end-to-end
smoke-tested. The
[Coverify](https://github.com/chaoxu/coverify) layer lives in a separate repo
and talks to Cosheaf over the HTTP API.
