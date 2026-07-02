# Workbench Local Writing Annotations

This document defines the near-term architecture for local Workbench writing
metadata: comments, TODOs, and AI-facing notes used while drafting a paper or
technical note. The first target workflow is a single user plus AI working in a
local paper folder such as `~/playground/ESA` on `earth`.

The goal is not global collaborative review yet. Workbench should first become a
good local writing cockpit: read the document, mark issues in context, ask AI to
work from those marks, review edits, and resolve the marks.

## Product Boundary

Local annotations are drafting affordances, not collaboration records.

- Document content lives in the user's files and git working tree.
- Local annotations live in a gitignored Workbench sidecar.
- Formal shared issues, pull requests, and review comments still belong to the
  remote Core API when a workspace is connected.
- Moving local annotations into shared collaboration is a future explicit
  promotion/sync feature, not the default transport.

This keeps the first version useful for the common case: one person is editing a
paper locally and using AI as a writing assistant.

## Storage

Workbench stores local annotations under the opened folder's `.cosheaf/`
sidecar, which is already protected by `.cosheaf/.gitignore`.

Initial file:

```text
<workspace>/.cosheaf/local-annotations.json
```

This file is private local Workbench state. It must not be committed by the
Workbench commit flow, and it must not be interpreted as shared review state.

Suggested shape:

```json
{
  "annotations": {
    "la_k7f3m2q9x1p0": {
      "id": "la_k7f3m2q9x1p0",
      "kind": "comment",
      "status": "open",
      "path": "paper.md",
      "anchor": "[@local:la_k7f3m2q9x1p0]",
      "created_at": "2026-07-01T19:10:00.000Z",
      "updated_at": "2026-07-01T19:10:00.000Z",
      "messages": [
        {
          "id": "msg_k7f3m2q9x1p0",
          "author": "chao",
          "created_at": "2026-07-01T19:10:00.000Z",
          "body": "Please clarify this step."
        }
      ]
    }
  }
}
```

The file shape is deliberately simple so Codex or another local agent can read
and update it without a database client. Workbench may later mirror it into
SQLite for search or SSE fanout, but JSON remains the durable local source.

## Anchors

Document text may contain a local annotation marker:

```markdown
We reduce the instance to a grid gadget[@local:la_k7f3m2q9x1p0].
```

The marker is intentionally explicit:

- `@local:` means local Workbench drafting metadata.
- The id after the prefix points to the sidecar annotation.
- The marker can move with the surrounding sentence, which is better than a
  line-number-only anchor for active writing.

The marker namespace is not global review syntax. If a future sync feature is
added, promotion to Core comments should create remote records explicitly.

## AI Workflow

Codex remains the main conversational AI interface. Workbench provides a
document-grounded task surface that Codex can inspect.

Minimum useful loop:

1. User highlights a paragraph or places the cursor and adds a local comment or
   task.
2. Workbench inserts an `[@local:<id>]` marker and creates the sidecar record.
3. Codex reads unresolved annotations through a local API or the sidecar file.
4. Codex edits the document, optionally appends a message to the annotation,
   and resolves it when done.
5. User reviews the document in Workbench and reopens or resolves as needed.

Implemented local API shape:

- `GET /api/v1/repos/:owner/:repo/local-annotations`
- `GET /api/v1/repos/:owner/:repo/local-annotations/unresolved`
- `POST /api/v1/repos/:owner/:repo/local-annotations`
- `PATCH /api/v1/repos/:owner/:repo/local-annotations/:id`
- `POST /api/v1/repos/:owner/:repo/local-annotations/:id/messages`
- `DELETE /api/v1/repos/:owner/:repo/local-annotations/:id`

The unresolved queue includes path, anchor id, status, messages, and source
context (`line`, `excerpt`, `anchor_found`) so Codex can pick up document-local
writing tasks without scraping the UI.

## UI Direction

The Workbench UI should use a bottom drawer for local annotations.

Expected first controls:

- Add comment / add task
- Show unresolved
- Jump to next unresolved
- Resolve / reopen
- Thread messages for the selected annotation

Coflat should render local markers as subtle document highlights. Clicking a
highlight should open the drawer focused on that annotation. This rendering
belongs in Coflat or a documented Coflat host extension, not as ad hoc HTML
rewrites in Cosheaf.

## Export and PDF Safety

Local drafting markers must not leak into final output.

Implemented near-term rule:

- Workbench final export/PDF fails while any `[@local:...]` marker remains in
  the source, including resolved annotations. Resolved means the drafting task is
  done; it does not mean the authoring marker is safe to publish.

The current Workbench PDF export fails before invoking Pandoc if the source
contains any `[@local:...]` marker, whether the matching sidecar annotation is
open, resolved, missing, or unreadable. It also fails when an open sidecar
annotation exists for the file but its anchor is absent from source, so authors
do not accidentally export while local comments are detached from the text.

Later rule, if useful:

- A draft export mode may strip local anchors.
- A final export mode should fail on unresolved local anchors by default.

Draft-mode stripping remains a future policy question.

## Future Work

Out of scope for the first local writing workflow:

- Syncing local annotations across machines.
- Promoting local annotations to Core comments.
- Multi-user concurrent editing.
- Shared bottom-drawer presence or real-time collaboration.
- Treating local annotations as PR review comments.

Those should be designed after the local writing loop is useful.
