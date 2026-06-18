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

Still meaningfully split:

- `@chaoxu/coflat/src/reader/reader.ts` is a large HTML-string renderer.
- `@chaoxu/coflat/src/editor/render/preview-block-renderer.ts` is a separate DOM renderer.
- `@chaoxu/coflat/src/reader/reader.ts` still has its own inline node renderer.
- `@chaoxu/coflat/src/editor/render/inline-render.ts` renders a separate `InlineFragment` model.
- Reader-only behaviors include source-position attributes, truncation, reference-preview indexing, outline id generation, and disclosure hydration.
- Editor-only behaviors include CM6 widgets, viewport mounting, editable/source transitions, and non-interactive preview rendering.

## Regression Commands

- Broad local browser parity: `pnpm smoke:reader-parity`
- Temporary live canary: `pnpm verify:cogirth-outline`. This is useful while
  Cogirth is an active production editing target, but it must not be the final
  parity regression because the document and branch are not permanent fixtures.
- Coflat pin status: `pnpm coflat:status`
- Production status: `pnpm coflat:status -- --prod`

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
- Cosheaf: `pnpm verify:cogirth-outline`

### Phase 2: Shared Block Render Plan

Goal: introduce a neutral block render plan generated from the Lezer tree and
document semantics. Reader and editor preview emit from that plan rather than
walking blocks independently.

Start with low-risk blocks:

- Paragraphs
- Headings
- Horizontal rules
- Lists
- Blockquotes

Then move higher-risk blocks:

- Fenced div theorem/proof blocks
- Tables
- Footnotes
- Display math
- Code blocks

Verification:

- Expand `preview-reader-parity.test.ts` for every migrated block.
- Keep intentional differences explicit in test normalization, not hidden in
  renderer code.

### Phase 3: Surface Policy Objects

Goal: replace ad hoc surface strings with typed policy objects.

Policies should explicitly state:

- Links: active, inert, or stripped.
- References: resolved, inert, or source-like.
- Images: rendered, loading placeholder, or alt text.
- Footnotes: numbered reference, raw id, or omitted.
- Interactivity: reader disclosure, editor widget, hover card, outline label.

### Phase 4: Corpus and Production Regression Expansion

Goal: make exact user regressions first-class checks without depending on one
live production document.

Add named checks for:

- A stable Coflat fixture repo/page that covers the current Cogirth outline
  theorem-label regression.
- Reader hover card target selection.
- Editor hover card target selection.
- Reader/editor outline display equivalence.
- Coflat showcase typography and geometry parity.

Exit criterion:

- Retire `pnpm verify:cogirth-outline` from the standard parity gate once the
  fixture-backed outline-label check exists and covers the same failure.

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
| Editor outline raw crossref labels | Fixed | temporary `pnpm verify:cogirth-outline`; replace with fixture-backed check |
| Unified inline renderer | Planned | Phase 1 |
| Shared block render plan | Planned | Phase 2 |
| Typed surface policies | Planned | Phase 3 |
