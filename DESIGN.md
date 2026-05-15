# Cosheaf Design

## What It Is

Cosheaf is a multi-user knowledge base for Coflat-flavored markdown files.
Pages are stored in Forgejo repositories; Cosheaf is a human-usable Forgejo UI
for editing, branches, pull requests, reviews, issues, search, and backlinks.

Cosheaf was originally motivated by mathematical knowledge-base work, and
Coflat markdown is designed to be comfortable for mathematical writing, with
math syntax, theorem-style blocks, cross-references, citations, and LaTeX export
conventions. Cosheaf does not model mathematical objects as a separate graph:
the durable unit is still the markdown page, and the sidecar index stores only
page metadata, links, tags, search text, and workflow state.

Coflat is the only supported document format today. The architecture should not
pretend that formats are pluggable yet, though future work may allow a workspace
to choose another markdown profile or document format.

Cosheaf is meant to be useful with only human users. Autonomous agents can
participate later through the same HTTP API as ordinary members or verifiers.

## Core Philosophy

- **Forgejo is the source of truth.** Workspace content lives in a Forgejo repo.
  SQLite is a sidecar for fast reads, sessions, memberships, change metadata,
  search, backlinks, and tags.
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

Pages use YAML frontmatter plus Coflat-flavored markdown:

```yaml
---
id: ksh1jyxe
title: Compactness
---
```

Only `page` documents are currently indexed as first-class documents. The
indexed page status is reported as `golden` for API compatibility, but durable
review state lives on `Change`, not page frontmatter.

Cosheaf indexes:

- title and body in FTS5 using the trigram tokenizer
- tags from frontmatter
- backlinks from `[@id]` and `[text](relative.md[#fragment])`
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

Cosheaf may keep compatibility names in code while the implementation catches
up, but the product language should follow Forgejo: branch, pull request,
review, merge, close, issue.

## Trust Model

Workspace roles:

- `owner`: create/configure workspace, direct publish, approve, request changes, close, merge.
- `verifier`: author changes and approve/request changes reviewed changes.
- `member`: author changes and publish for review.

Review decisions are Forgejo pull-request reviews. SQLite mirrors enough pull
request state for the queue and UI, but Forgejo remains the durable review record.
`min_approvals` maps to Forgejo branch protection on `main`.

## Reconciliation

Forgejo webhooks notify Cosheaf about pushes, pull requests, reviews, comments,
and issues. Webhook handlers reindex markdown files from Forgejo raw content,
update change state, and publish SSE events to open browsers.

If webhooks are missed, `pnpm cli workspace reindex <slug>` rebuilds the page
index from Forgejo `main` and removes stale page index rows.

## Autoprover Boundary

The autoprover layer is intentionally out of this repo. It will:

- authenticate via personal API tokens
- subscribe to SSE events
- read pages, search, and walk backlinks
- create changes, publish them, and participate in review

Cosheaf will not import or call agent code. If an agent needs a capability,
that should become an HTTP API feature usable by humans too.

## Stack

- **Server**: Node, TypeScript, Hono, `better-sqlite3`, Forgejo REST API,
  argon2 for password hashing.
- **Client**: React 19, Vite, Tailwind v4, shadcn-style primitives, and
  `@chaoxu/coflat-editor`.
- **Format**: Coflat-flavored Pandoc markdown per `FORMAT.md`.

## Out Of Scope

- The editor implementation itself; it lives in `@chaoxu/coflat-editor`.
- Agent/prover orchestration.
- Built-in Pandoc export and desktop-native behavior. These may return later as
  optional Cosheaf operations rather than core requirements; see
  [Bring Coflat Operations Into Cosheaf](./docs/epics/coflat-operations.md).
