# Cosheaf Design

## What It Is

Cosheaf is a multi-user knowledge base for
[Coflat](https://github.com/chaoxu/coflat)-flavored markdown files. Pages are
stored in Forgejo repositories; Cosheaf is a human-usable Forgejo UI for
editing, branches, pull requests, reviews, issues, search, and backlinks.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is designed to be comfortable for mathematical writing, with
math syntax, theorem-style blocks, cross-references, citations, and LaTeX export
conventions. Cosheaf does not model mathematical objects as a separate graph:
the durable unit is still the markdown page, and the document index stores
page metadata, links, tags, and search text.

Cosheaf markdown is Coflat markdown. Pages use Coflat's math-friendly parsing,
`[@id]` backlinks, and rich rendered diffs.

Cosheaf is meant to be useful with only human users. Autonomous agents can
participate through the same HTTP API as ordinary Forgejo collaborators, and
the optional Chat surface is only a Forgejo-issue-backed bridge to that outside
agent layer.

## Core Philosophy

- **Forgejo is the source of truth.** Workspace content lives in a Forgejo repo.
  SQLite is a sidecar for fast reads, search, backlinks, tags, webhook dedupe,
  and server-side cached backend Forgejo credentials. Identity, workspace
  registry, and audit logs live on Forgejo — there is no `users`, `sessions`, or
  `workspaces` table.
- **Use Forgejo terms directly.** Cosheaf should mirror Forgejo's branch, pull
  request, review, issue, merge, and close model instead of inventing parallel
  workflow concepts. A user should be able to perform the same durable
  operations in Forgejo without Cosheaf.
- **Plain markdown remains inspectable.** The durable content is still ordinary
  `.md` files with YAML frontmatter for stable Cosheaf ids and titles.
- **Workflow is trust, not automation.** Review and approval exist because
  collaborative knowledge work needs accountability. Agents are one possible
  participant, not a special workflow path.
- **Substrate, not semantic engine.** Cosheaf does not prove theorems, run
  checkers, infer dependencies, or schedule exploration. Those concerns belong
  in another layer that talks to Cosheaf over HTTP.

## Document Model

Pages use YAML frontmatter plus Coflat markdown:

```yaml
---
id: ksh1jyxe
title: Compactness
---
```

Only `page` documents are currently indexed as first-class documents. Durable
review state lives on Forgejo pull requests and reviews, not page frontmatter.

Cosheaf indexes:

- title and body in FTS5 using the trigram tokenizer
- tags from frontmatter
- backlinks from the Coflat link extractor
- path-to-id mappings in `doc_map`

## Branch And Pull Request Model

Edits happen on Forgejo branches. A branch is saved work. A pull request is the
review wrapper around a branch compared to `main`. Merging the pull request
makes the branch content canonical.

```
branch without PR ──open PR──▶ pull request ──approve/merge──▶ merged
                                  │
                                  └──request changes──▶ same PR, branch updated

branch deleted or PR closed unmerged ──▶ closed/discarded
```

Authors can keep one or more branches open without asking for review. Opening a
Forgejo pull request submits a branch for review. Owners may merge when branch
protection allows it. A request-changes review is non-terminal feedback: the PR
stays open, the branch is kept, and the author pushes more commits to the same
branch.

Older compatibility names should be retired as Forgejo-native routes land. The
product and implementation language should follow Forgejo: branch, pull
request, review, merge, close, issue.

## Trust Model

Workspace roles:

- `admin`: create/configure workspace, push branches, open pull requests,
  review, close, and merge when Forgejo branch protection allows it.
- `write`: push branches, open pull requests, review, and comment.
- `read`: view workspace content and Forgejo pull request/issue state.

Review decisions are Forgejo pull-request reviews. SQLite does not mirror pull
requests, reviews, memberships, labels, milestones, or issues as durable state.
The UI queries Forgejo and only shapes responses where Cosheaf adds a human
knowledge-base view.
`min_approvals` maps to Forgejo branch protection on `main`.

## Reconciliation

Forgejo webhooks notify Cosheaf about pushes, pull requests, reviews, comments,
and issues. Webhook handlers reindex markdown files from Forgejo raw content,
invalidate derived views, and publish SSE events to open browsers.

If webhooks are missed, `pnpm cli workspace reindex <owner>/<repo>` rebuilds
the page index from Forgejo `main` and removes stale page index rows.

## Coverify Boundary

The [Coverify](https://github.com/chaoxu/coverify) layer is intentionally out
of this repo. It:

- authenticate with opaque Cosheaf tokens
- read pages, search, and walk backlinks
- push branches, open pull requests, and participate in reviews
- answer issue-backed chats through Cosheaf's typed API when the optional chat
  bridge starts it

Cosheaf does not implement gatherers, oracles, provers, or agent scheduling.
The optional chat bridge only starts the external Coverify command and lets it
read/write through the public Cosheaf API as a bot account. If an agent needs a
new repository capability, that should become an HTTP API feature usable by
humans too.

## Stack

- **Server**: Node, TypeScript, Hono, `better-sqlite3`, Forgejo REST API.
  No Cosheaf-side password hashing — opaque Cosheaf tokens are the client
  credentials, sent as an HttpOnly browser cookie or as
  `Authorization: Bearer <token>`. Cosheaf maps those tokens to backend forge
  credentials internally.
- **Web**: server-rendered Hono pages, `public/cosheaf-web.css`, and narrow
  React 19 + Vite islands for the rich editor/reader surfaces.
- **Editor**: [`@chaoxu/coflat`](https://github.com/chaoxu/coflat).
- **Format**: Coflat-flavored Pandoc markdown per
  [Coflat `FORMAT.md`](https://github.com/chaoxu/coflat/blob/main/FORMAT.md);
  Cosheaf's [`FORMAT.md`](./FORMAT.md) records only host-specific behavior.

## Out Of Scope

- The editor implementation itself; it lives in
  [`@chaoxu/coflat`](https://github.com/chaoxu/coflat).
- Agent/prover orchestration beyond the optional issue-backed chat launcher.
- Built-in Pandoc export and desktop-native behavior. These may return later as
  optional Cosheaf operations rather than core requirements; see
  [Bring Coflat Operations Into Cosheaf](./docs/epics/coflat-operations.md).
