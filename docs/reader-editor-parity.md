# Reader/Editor Parity Plan

## Operating Model

Reader/editor parity work should move in small verified slices:

1. Pick one visible drift.
2. Add or update a focused regression test.
3. Move the behavior into shared Coflat semantics or shared surface builders.
4. Run focused Coflat tests, then the normal Coflat gates.
5. Bump Cosheaf, run Cosheaf gates, deploy, and browser-check the exact user route.

The target architecture is one parse tree, one semantic model, one render plan,
and multiple emitters. Reader/editor should not independently interpret
Markdown.

## Current State

Already shared or recently aligned:

- Parser entry: both reader and editor preview use the shared Coflat Lezer parser.
- Tables: shared table and row surface helpers.
- Media: shared image/loading surface helpers.
- Math: shared inline/display math surface helpers.
- Code blocks: shared code block surface.
- Headings: shared heading surface, Setext handling, and closed-marker handling.
- Footnotes: shared entry/reference surface and shared numbering in preview.
- Outline labels: editor outline exposes rendered Coflat HTML and Cosheaf uses it.
- Inline rendering: reader static and source-position inline rendering consume
  the shared Coflat `InlineFragment` model, including source ranges for
  hydration and selection metadata.
- Paragraphs: reader and editor preview consume a shared paragraph render plan
  before emitting HTML or DOM.
- Headings, horizontal rules, and blockquotes: reader and editor preview now
  consume shared syntax-level render plans before applying surface-specific
  numbering, hydration, or DOM/HTML emission.
- Lists: reader and editor preview now consume a shared syntax-level render
  plan for ordered/unordered shape, looseness, task marker state, item marker
  numbering, tight-item paragraph unwrapping, and trimmed task-item body
  content.
- Document traversal: reader and editor preview now share a document render
  plan for frontmatter skipping, inter-block blank lines, trailing blank lines,
  and reader-only leading title blocks.
- Display math and fenced div blocks: reader and editor preview now share
  source-level plans for math labels/latex and semantic block attributes,
  titles, title inline fragments, numbering presentation, body children, and
  preserved blank lines.
- Tables: reader and editor preview now share a table render plan for
  delimiter-derived alignments, header/body rows, cell nodes, ragged rows, and
  header-only tables before emitting HTML or DOM. Table cells now also carry
  shared inline fragments, text, source ranges, and math state.
- Code blocks: reader and editor preview now share language/content extraction
  through a code block render plan before emitting HTML or DOM.
- Footnote definitions: reader and editor preview now share id/body extraction
  and inline fragment planning before emitting footnote entry surfaces.
- Document assembly: reader and editor preview now share top-level renderable
  block order, frontmatter skipping, inter-block blank ranges, and trailing
  blank range planning before emitting HTML or DOM.
- Task list items: reader and editor preview now share trimmed task content
  ranges and markdown content before emitting list item bodies.
- Inline surface policy: reader and editor preview now share a typed policy for
  link, reference, image, footnote, and hard-break behavior across document
  body, document-inline, table-preview, and UI-chrome inline surfaces.
- Document surface policy: reader and editor preview now share a typed policy
  for semantic block disclosure interactivity, making reader interactive
  disclosure and editor static preview an explicit surface choice.
- Document surface policy now also owns inline-surface choices and reference
  host routing for reader, editor, editor preview, hover preview, completion
  preview, and outline labels.

Still meaningfully split:

- `@chaoxu/coflat/src/reader/reader.ts` is a large HTML-string renderer.
- `@chaoxu/coflat/src/editor/render/preview-block-renderer.ts` is a separate DOM renderer.
- Reader-only behaviors include source-position attributes, truncation, reference-preview indexing, outline id generation, and disclosure hydration.
- Editor-only behaviors include CM6 widgets, viewport mounting, editable/source transitions, and non-interactive preview rendering.

## Regression Commands

- Broad local browser parity: `pnpm smoke:reader-parity`
- Optional live canary: `pnpm verify:cogirth-outline`. This is useful only
  while Cogirth is an active production editing target; durable outline/hover
  regressions live in the seeded `pnpm smoke:reader-parity` fixture.
- Coflat pin status: `pnpm coflat:status`
- Production status: `pnpm coflat:status --prod`

## Implementation Plan

### Phase 1: Inline Unification

Goal: reader inline rendering consumes the same `InlineFragment` model and
reference presentation context as editor preview.

Expected payoff:

- Avoid raw `@id` / `[@id]` leaks.
- Keep links, citations, references, math, hard breaks, footnotes, and inline
  code consistent across reader, editor, outline, hover, and comments.

Verification:

- Coflat: `src/editor/render/inline-render.test.ts`
- Coflat: `src/editor/render/preview-reader-parity.test.ts`
- Coflat: `src/editor/reader-render.test.ts`
- Cosheaf: `pnpm smoke:reader-parity`

### Phase 2: Shared Block Render Plan

Goal: introduce a neutral block render plan generated from the Lezer tree and
document semantics. Reader and editor preview emit from that plan rather than
walking blocks independently.

Start with low-risk blocks:

- Paragraphs
- Headings
- Horizontal rules
- Blockquotes
- Lists

Then move higher-risk blocks:

- Footnotes (done for definition body planning; document-order section policy
  remains part of Phase 3 surface-policy work)
- Code blocks (done for language/content planning)

Verification:

- Expand `preview-reader-parity.test.ts` for every migrated block.
- Keep intentional differences explicit in test normalization, not hidden in
  renderer code.

### Phase 3: Surface Policy Objects

Goal: replace ad hoc surface strings with typed policy objects.

Policies should explicitly state:

- Links: active or inert.
- References: resolved or inert.
- Images: rendered or alt text.
- Footnotes: numbered reference or raw superscript.
- Interactivity: reader disclosure vs static preview is explicit; editor
  reference widgets, hover cards, completion previews, and outline labels now
  use typed document-surface policies for presentation routing.

### Phase 4: Corpus and Production Regression Expansion

Goal: make exact user regressions first-class checks without depending on one
live production document.

Add named checks for:

- A stable Coflat fixture repo/page that covers the current Cogirth outline
  theorem-label regression. (done in `coflat-feature-showcase.md`)
- Reader hover card target selection. (done in `pnpm smoke:reader-parity`)
- Editor hover card target selection. (done in `pnpm smoke:reader-parity`)
- Reader/editor outline display equivalence. (done in `pnpm smoke:reader-parity`)
- Coflat showcase typography and geometry parity. (done in `pnpm smoke:reader-parity`)
- Tablet/mobile reader-editor document width and rail breakpoint parity. (done
  in `pnpm smoke:reader-parity`)

Exit criterion:

- `pnpm verify:cogirth-outline` is retired from the standard parity gate and
  remains only an optional live canary for the active Cogirth production doc.

## Ledger

| Drift | Status | Regression |
| --- | --- | --- |
| Table cell math propagation | Fixed | Coflat table reader/editor tests |
| Ragged table row shape | Fixed | `preview-reader-parity.test.ts` |
| Header-only table body | Fixed | `preview-reader-parity.test.ts` |
| Hard line breaks | Fixed | `preview-reader-parity.test.ts` |
| Setext heading semantics | Fixed | `preview-reader-parity.test.ts` |
| Closed ATX heading markers | Fixed | `preview-reader-parity.test.ts` |
| Media loading/rendered surface | Fixed | `preview-reader-parity.test.ts` |
| Footnote reference numbering | Fixed | `preview-reader-parity.test.ts` |
| Editor outline raw crossref labels | Fixed | seeded `pnpm smoke:reader-parity` outline-label check |
| Unified inline fragments for static + source-position reader inline rendering | Fixed | `inline-fragments.test.ts`; `reader-source-map.test.ts`; `reader-render.test.ts`; `preview-reader-parity.test.ts` |
| Shared paragraph block render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared heading / horizontal-rule / blockquote render plans | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-outline.test.ts`; `reader-source-map.test.ts` |
| Shared list render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts`; `test:e2e:corpus` |
| Shared task-item body normalization | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared document traversal render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared display math render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts`; `test:e2e:corpus` |
| Shared fenced div render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `hover-preview.render.test.ts`; `test:e2e:corpus` |
| Shared fenced-div title inline fragment planning | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared table render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `test:e2e:corpus` |
| Shared table-cell inline fragment planning | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared code block render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared footnote definition render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts` |
| Shared document assembly render plan | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader-source-map.test.ts`; `reader-outline.test.ts` |
| Shared task-list content normalization | Fixed | `block-render-plan.test.ts`; `preview-reader-parity.test.ts` |
| Typed inline surface policies | Fixed | `inline-surface-policy.test.ts`; `inline-render.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `test:e2e:corpus` |
| Typed semantic block disclosure policy | Fixed | `document-surface-policy.test.ts`; `preview-reader-parity.test.ts`; `reader-render.test.ts`; `reader.crossref.test.ts` |
| Typed document surface policies for reader/editor/hover/completion/outline routing | Fixed | `document-surface-policy.test.ts`; `inline-surface-policy.test.ts`; `inline-render.test.ts`; `document-surfaces.test.ts`; `per-file-panels.test.ts`; `test:e2e:corpus` |
| Stable fixture-backed outline/hover/geometry parity | Fixed | `pnpm smoke:reader-parity`; `devx-what-to-run.test.mjs` |
| Responsive reader/editor rail breakpoint and width parity | Fixed | `pnpm smoke:reader-parity` |
