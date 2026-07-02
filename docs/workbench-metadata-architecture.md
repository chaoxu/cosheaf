# Workbench Metadata & Commenting Architecture

This document defines the implementation specification for handling transient/working metadata (such as inline comments, todo lists, and AI session states) in the local Cosheaf Workbench. 

---

## 1. The Core Philosophy: "How do we transport non-document metadata?"

In an AI-collaborative writing environment, there is a distinct boundary between:
* **Source Content** (final text, figures, bibliography) -> committed to the main document files (`main.md`).
* **Collaboration Metadata** (comments, task statuses, AI session logs) -> stored out-of-file so they do not pollute the raw markdown or final PDF.

To transport this metadata without bloating the Git repository or relying on complex real-time database sync engines, we divide metadata into two transport pathways:

1. **Git-Native Transport (The Committed Sidecar)**: Local working comments and AI tasks are stored in a structured JSON file committed to Git (`.cosheaf/comments.json`). They are branched, merged, and shared via standard `git push`/`pull` operations.
2. **Forge-Native Transport (The API Registry)**: Formal team-wide PR review comments and issues are stored on the Gitea server and fetched by the Workbench via APIs, cached locally in a gitignored SQLite sidecar.

---

## 2. In-Text Comment Anchoring & Syntax

To ensure comments never drift or become outdated when text paragraphs are shifted or refactored, comments are anchored directly in the markdown text using Coflat's citation-aligned syntax:

```markdown
We can reduce the problem to reduction-to-grid[@c:c_a8f921] in polynomial time.
```

### 2.1 Sigil Reservation & Autocomplete
* The prefix **`@c:`** and **`[@c:`** are reserved exclusively for comment references.
* Typing `[@` in the CodeMirror editor triggers autocomplete for citations (`refs.bib`) and page backlinks.
* Typing `[@c:` immediately switches the editor's autocomplete filter to display active comment threads from the sidecar database.
* **Auto-insertion**: The user can highlight a text span and press `Cmd+Alt+M` (or click "Comment" in the UI). The editor automatically generates a unique ID, inserts `[@c:c_xxxxxx]` at the cursor, and focuses the comment drawer.

---

## 3. The Committed Sidecar Schema (`.cosheaf/comments.json`)

The rich metadata, author attributions, and discussion threads are stored in `.cosheaf/comments.json`:

```json
{
  "c_a8f921": {
    "status": "open",
    "assignee": "ai",
    "thread": [
      {
        "author": "chaoxu",
        "timestamp": "2026-07-01T19:10:00Z",
        "text": "Please clarify this step."
      },
      {
        "author": "ai",
        "timestamp": "2026-07-01T19:11:15Z",
        "text": "I will rewrite it to highlight the grid coordinate mapping."
      }
    ]
  }
}
```

### 3.1 Resolving Git Conflicts
Because comments are added as distinct keys in the JSON object mapping, standard Git merges will cleanly integrate additions from different collaborators without conflicts.

---

## 4. Compiler Integration (LaTeX/PDF Safety)

During document compilation (e.g. `make pdf` or running Pandoc), the Pandoc Lua filter ([`latex/filter.lua`](file:///Users/chaoxu/playground/cosheaf/latex/filter.lua)) must strip comment references:

```lua
-- In latex/filter.lua
function Cite(el)
  -- Strip comment citations completely from the LaTeX output
  if el.citations[1].id:match("^c:") then
    return {}
  end
  return el
end
```

This guarantees that comments never appear in the compiled LaTeX source or final PDF paper.

---

## 5. UI Layout: The Bottom Drawer

The Workbench UI displays local comments and AI conversations in a **toggleable bottom drawer** (collapsible like a terminal console):
- **Coflat Editor**: Renders `[@c:commentId]` markers as inline yellow highlights. Clicking a highlight slides open the bottom drawer and focuses the active comment thread.
- **Interactive Checkbox Lists**: Markdown checkboxes (`- [ ]`) written inside comment threads are parsed and rendered as interactive check-lists in the drawer. Clicking them edits the JSON/markdown files on disk.
- **Live Sync**: The Workbench server runs an `fs.watch` file watcher on `comments.json` (or uses SQLite change triggers) and broadcasts updates to the browser via Server-Sent Events (SSE) for real-time rendering.

## 6. Current Local-Only Queue Contract

The first Workbench implementation uses local `[@local:<id>]` anchors and the
gitignored sidecar `.cosheaf/local-annotations.json`. Agents can read unresolved
local writing tasks through:

```text
GET /api/v1/repos/:owner/:repo/local-annotations/unresolved
```

The response is:

```json
{
  "annotations": [
    {
      "id": "a1",
      "anchor": "local:a1",
      "path": "paper.md",
      "kind": "task",
      "status": "open",
      "messages": [{ "author": "me", "timestamp": "2026-07-02T00:00:00Z", "text": "Clarify this step." }],
      "source_excerpt": { "line": 4, "start_line": 2, "end_line": 6, "text": "..." }
    }
  ],
  "count": 1,
  "sidecar": ".cosheaf/local-annotations.json"
}
```

The sidecar may use either `{ "annotations": [...] }` or an object map keyed by
annotation id. Each record should include `id`, `path`, `kind` (`comment` or
`task`), `status` (`open` or `resolved`), and `messages` (or legacy `thread`).
Resolved records are omitted from the unresolved queue.
