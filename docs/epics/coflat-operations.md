# Epic: Bring Coflat Operations Into Cosheaf

## Summary

Cosheaf should eventually replace the standalone Coflat app shell while keeping
`@chaoxu/coflat-editor` as the editor package. Cosheaf owns workspaces, users,
issues, branches, pull requests, Forgejo storage, search, backlinks, assets, and
optional operations around canonical markdown files.

This epic tracks the important Coflat app operations that should move into
Cosheaf. Not every operation belongs in core. Some capabilities, especially
export, should be extension-style so a minimal Cosheaf deployment remains a
review-gated knowledge base without requiring Pandoc, LaTeX, or native desktop
dependencies.

## Product Direction

Cosheaf is the self-hosted, Git-native, review-gated knowledge base for Coflat
markdown. More precisely, it should be a Forgejo-native UI with custom Coflat
markdown rendering: branches are branches, pull requests are pull requests,
issues are issues, and merged `main` is canonical. Coflat was originally built
for mathematical documents, so the current format is math-friendly, but Cosheaf
remains page-oriented rather than math-native.

The future split should be:

- `@chaoxu/coflat-editor`: document editing, parsing, rich/source rendering, and
  in-editor Coflat semantics.
- `cosheaf`: Forgejo-backed canonical storage, branches, pull requests, issues,
  review gates, search, backlinks, assets, and optional document operations.

## Required Core Work

These features are core because they support normal authoring inside a
Forgejo-backed workspace.

1. Project-level Coflat config

   Add workspace/repo support for `coflat.yaml` and make it available to the
   editor and indexer. It should cover project-level math macros, block
   definitions, bibliography defaults, CSL defaults, and image folder defaults.

2. Repo-aware assets

   Support image/PDF/binary assets as files in the Forgejo repo. The UI should
   let users upload or paste assets into the configured image folder and insert
   stable relative markdown links. Asset writes should follow the same
   branch and pull request workflow as page edits.

3. Editor configuration bridge

   Pass workspace and document configuration into `@chaoxu/coflat-editor`
   instead of treating the editor as a raw markdown textarea. This includes
   project config, frontmatter-derived options, asset resolution, and
   read-only/review contexts.

4. Document diagnostics surface

   Show useful Coflat document diagnostics in Cosheaf: missing bibliography
   files, unresolved citations, unresolved cross-references, duplicate labels,
   malformed fenced divs, missing assets, and unsupported format constructs.
   Diagnostics should be informational by default and should not block review
   unless a future workspace policy explicitly asks for that.

5. Authoring documentation

   Bring the task-oriented Coflat authoring guide into Cosheaf docs, adjusted
   for the Forgejo branch and pull request workflow. `FORMAT.md` remains the canonical syntax
   reference; the authoring guide explains practical workflows.

## Extension-Style Work

These capabilities are valuable, but should not be required for every Cosheaf
deployment.

1. Export extension

   Provide PDF, LaTeX, and HTML export from canonical markdown using Pandoc and
   the existing Coflat export conventions. This should be implemented as an
   optional server-side capability with dependency checks for `pandoc`,
   `latexmk`, templates, filters, bibliography files, and CSL files.

   The first version can be workspace-local and synchronous. Later versions can
   add job queues, artifact retention, batch export, and per-workspace policy.

2. Import/conversion extension

   Support LaTeX-to-Coflat conversion and other import paths as optional tools.
   Imports should create a branch rather than writing directly to `main`.

3. Desktop/native extension

   A desktop shell may be useful later, but it should not be required for the
   web-first Cosheaf model. If revived, it should be a thin client over the same
   HTTP API rather than a separate local-file product.

4. Advanced semantic indexing

   Richer block/equation/citation indexing may help diagnostics and navigation,
   but Cosheaf should not grow a theorem dependency graph by default. Any
   semantic index should serve authoring/review UX, not become hidden canonical
   knowledge.

## Non-Goals

- Do not move the editor implementation into Cosheaf.
- Do not make export part of the minimum server startup path.
- Do not require Pandoc, LaTeX, or desktop-native dependencies for ordinary
  page editing and review.
- Do not add a math-native theorem graph or proof dependency model.
- Do not introduce pluggable document formats yet; Coflat remains the only
  supported format for now.

## Milestones

### Milestone 1: Config and Assets

- Read `coflat.yaml` from Forgejo-backed workspaces.
- Merge project config with page frontmatter.
- Pass config into the editor.
- Add repo-aware asset upload/paste flows.
- Index missing asset references as diagnostics.

### Milestone 2: Diagnostics and Authoring Docs

- Surface Coflat diagnostics in the page editor.
- Add a workspace-level diagnostics view.
- Port the authoring guide into Cosheaf docs.
- Add smoke tests for unresolved refs, missing bibliography, and missing assets.

### Milestone 3: Export Extension

- Add optional export capability detection.
- Expose PDF/LaTeX/HTML export endpoints.
- Use canonical Forgejo content as export input.
- Include bibliography, CSL, assets, templates, and math macros.
- Store or stream export artifacts with clear failure messages.

### Milestone 4: Import Extension

- Add optional import/conversion entry points.
- Convert imported content into a branch.
- Keep conversion output inspectable as ordinary markdown before review.

## Open Questions

- Should export run in the main server process, a worker process, or an external
  job runner?
- Should export artifacts be committed to Forgejo, stored in sidecar data, or
  generated on demand?
- Should diagnostics ever become merge gates, or should they remain advisory?
- How much of Coflat's current browser regression harness should move to
  Cosheaf once the app shell is replaced?
