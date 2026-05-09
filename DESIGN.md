# Cosheaf — Design Document

## What is it

A multi-user mathematical knowledge base. Pages are Coflat-flavored markdown
files on disk; the workflow that turns drafts into trusted "golden" content
is a first-class part of the substrate, not bolted on.

Cosheaf is meant to be useful with only human users. It is also meant to be
usable by autonomous agents over the same HTTP API. Both kinds of participants
read the same files, file the same proposals, write the same reviews, and
count toward the same approval thresholds.

## Core philosophy

- **Plain files are the source of truth.** Everything visible in the app is
  derivable from the markdown files in `data/workspaces/<slug>/`. The SQLite
  index can be rebuilt by reindexing the directory.
- **Workflow is trust, not automation.** Approval, review, and golden status
  exist because a math wiki needs human review of changes to theorems and
  proofs. Agents are one kind of reviewer, not a separate concept.
- **Substrate, not platform.** Cosheaf does not know how to prove theorems,
  run mechanical checkers, schedule exploration, or repair rejected proposals.
  Those concerns belong in an autoprover layer that participates as a user.
- **No hidden semantics.** Frontmatter fields (`id`, `type`, `status`,
  `target`, `title`) are the only structured metadata. Everything else lives
  in the body, where humans and agents read and write the same way.
- **Author-friendly.** Editing a markdown file in any editor is a first-class
  operation. The watcher reconciles external edits into the index; the SSE
  stream pushes changes to open browsers; an external edit never silently
  loses status or causes data loss.

## Document model

Every document has YAML frontmatter:

```yaml
---
id: ksh1jyxe         # stable, generated once on first index
type: page           # page | proposal | review
status: golden       # draft | unreviewed | golden | rejected | archived
target: <id>         # only for proposals and reviews; the page they refer to
title: …             # derived from first heading if absent
---
```

The body is Coflat-flavored markdown (see `FORMAT.md`).

### Types

- **`page`** — primary content. Theorems, proofs, definitions, prose. Pages
  hold the long-lived knowledge.
- **`proposal`** — a suggested replacement body for a target `page`. Approving
  a proposal rewrites the target body in place and archives the proposal. The
  diff between proposal and target is shown to reviewers.
- **`review`** — a verifier's long-form report on a target. The verifier's
  reasoning lives in the body; the same document is FTS5-indexed, backlinked
  from the target, and citable as `[@id]`. An approval row points at the
  review via `review_doc_id`, so the row remains the unit of tally and the
  document remains the unit of reasoning.

### Lifecycle

```
draft ──submit──▶ unreviewed ──approve (≥ min)──▶ golden
                       │
                       └────reject──▶ rejected
                                          │
                                          └──(edit, submit again)──▶ unreviewed

unreviewed proposal ──approve (≥ min)──▶ archived
                                              └──merges body onto target page
```

`min_approvals` is per-workspace (default 1).

## Trust model

- **`memberships`** define what a user can do in a workspace:
  `owner` (full), `verifier` (can approve/reject), `member` (can author and
  propose).
- **Approvals are rows in `approvals`** keyed by `(workspace_id, document_id,
  verifier_user_id)`. The row records the decision, an optional one-line
  comment, and an optional pointer to a review document.
- **Reviews are documents** because reasoning should be reusable mathematical
  memory: searchable, linkable, citable, agent-readable. A short "lgtm" stays
  in the row's `comment`; a counterexample or a verification report belongs
  in a review document.

This split — **rows for the count, documents for the content** — keeps the
threshold logic simple while letting reviewers' reasoning accumulate as
first-class content over time.

## Autoprover boundary

The autoprover layer is intentionally out of this repo. It will:

- Authenticate as a user (or many users) via personal API tokens.
- Subscribe to SSE events to react to changes.
- Read pages, search by FTS, walk backlinks via the same HTTP API a human uses.
- Propose new pages or proposals, write reviews, post approvals/rejections.

Cosheaf will not import or call agent code. If autoprover ever needs
something cosheaf does not expose, that is a cosheaf API addition, not a
shared library. This keeps the substrate honest: it has to be usable by a
person before it is usable by a bot.

## Stack

- **Server**: Node, TypeScript, Hono, `better-sqlite3` (WAL mode), `fs.watch`
  for the workspace directory, Hono SSE for change events, argon2 for
  password hashing.
- **Client**: React 19, Vite, Tailwind v4, shadcn primitives themed against
  the editor's `--cf-*` CSS tokens for a uniform black-and-white look.
- **Editor**: `@chaoxu/coflat-editor` consumed as a published package. The
  editor is mounted via `mountEditor`; the cosheaf shell wraps it in a
  React component and lazy-loads it on first file open.
- **Format**: Coflat-flavored Pandoc markdown, parsed by Lezer (inside the
  editor package). KaTeX for math. See `FORMAT.md`.

## What is not in scope here

- The editor itself (rendering rules, plugins, parser). Lives in
  `@chaoxu/coflat-editor`.
- A desktop app. The previous Tauri shell was for the standalone editor;
  cosheaf is a server-backed web app.
- Pandoc export. Cosheaf reads and writes markdown; export is a downstream
  concern.
- Theorem proving, exploration, mechanical verification. Autoprover layer.
