import { type SourceRange, sourceRangeFromDataset } from "@chaoxu/coflat/reader";

interface RichDiffSourceRange extends SourceRange {
  readonly explicitTo: boolean;
}

interface RichDiffSourceBlock {
  readonly el: HTMLElement;
  readonly range: RichDiffSourceRange;
}

export function markChangedBlocks(root: ParentNode, marked: ReadonlySet<number>): void {
  const blocks = richDiffSourceBlocks(root);
  for (const [index, { el, range }] of blocks.entries()) {
    const effectiveRange = inferRichDiffSourceRange(range, blocks[index + 1]?.range);
    for (let line = effectiveRange.from; line <= effectiveRange.to; line++) {
      if (marked.has(line)) {
        el.classList.add("marked");
        break;
      }
    }
  }
}

export function richDiffBlockForLine(root: ParentNode, line: number): HTMLElement | null {
  const blocks = richDiffSourceBlocks(root);
  for (const [index, { el, range }] of blocks.entries()) {
    const effectiveRange = inferRichDiffSourceRange(range, blocks[index + 1]?.range);
    if (line >= effectiveRange.from && line <= effectiveRange.to) return el;
  }
  return null;
}

function richDiffSourceBlocks(root: ParentNode): RichDiffSourceBlock[] {
  return [...root.querySelectorAll<HTMLElement>("[data-source-line]")]
    .map((el) => ({ el, range: richDiffSourceRangeForElement(el.dataset) }))
    .filter((entry): entry is RichDiffSourceBlock => Boolean(entry.range));
}

function richDiffSourceRangeForElement(dataset: DOMStringMap): RichDiffSourceRange | null {
  // Rich diff `markedLines` are unified-diff line numbers. Coflat's
  // `data-source-from/to` values are character offsets when sourcePositions is
  // enabled, so line-diff highlighting must key off `data-source-line`.
  const lineRange = sourceRangeFromDataset(dataset, "sourceLine", "sourceLine", { defaultToFrom: true });
  return lineRange ? { ...lineRange, explicitTo: false } : null;
}

function inferRichDiffSourceRange(range: RichDiffSourceRange, next: RichDiffSourceRange | undefined): SourceRange {
  if (range.explicitTo) return { from: range.from, to: range.to };
  const inferredTo = next && next.from > range.from ? next.from - 1 : range.to;
  return { from: range.from, to: Math.max(range.to, inferredTo) };
}

export function _inferRichDiffSourceRangesForTest(
  ranges: readonly { readonly from: number; readonly to?: number; readonly explicitTo?: boolean }[],
): SourceRange[] {
  const richRanges = ranges.map((range): RichDiffSourceRange => ({
    from: range.from,
    to: range.to ?? range.from,
    explicitTo: Boolean(range.explicitTo),
  }));
  return richRanges.map((range, index) => inferRichDiffSourceRange(range, richRanges[index + 1]));
}

export function _richDiffRangeIndexForLineForTest(
  ranges: readonly { readonly from: number; readonly to?: number; readonly explicitTo?: boolean }[],
  line: number,
): number {
  const inferred = _inferRichDiffSourceRangesForTest(ranges);
  return inferred.findIndex((range) => line >= range.from && line <= range.to);
}

export function _richDiffSourceRangeForDatasetForTest(dataset: Record<string, string | undefined>): SourceRange | null {
  return richDiffSourceRangeForElement(dataset as DOMStringMap);
}
