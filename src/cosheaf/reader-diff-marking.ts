import { type SourceRange, sourceRangeFromDataset } from "@chaoxu/coflat/reader";

interface RichDiffSourceRange extends SourceRange {
  readonly explicitTo: boolean;
}

export function markChangedBlocks(root: ParentNode, marked: ReadonlySet<number>): void {
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-source-line],[data-source-from]")]
    .map((el) => ({ el, range: richDiffSourceRangeForElement(el.dataset) }))
    .filter((entry): entry is { el: HTMLElement; range: RichDiffSourceRange } => Boolean(entry.range));
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

function richDiffSourceRangeForElement(dataset: DOMStringMap): RichDiffSourceRange | null {
  const explicitRange = sourceRangeFromDataset(dataset, "sourceFrom", "sourceTo", { defaultToFrom: true });
  if (explicitRange) {
    return { ...explicitRange, explicitTo: Boolean(dataset.sourceTo) };
  }
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
