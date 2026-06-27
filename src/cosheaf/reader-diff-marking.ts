import { renderedAnchorsForSourceLineRange } from "@chaoxu/coflat/reader";

export interface RichInlineRange {
  from: number;
  to: number;
  kind: "del" | "add";
}

export function markChangedBlocks(root: ParentNode, marked: ReadonlySet<number>): void {
  const elements = new Set<HTMLElement>();
  for (const line of marked) {
    for (const anchor of richDiffAnchorsForLine(root, line)) {
      if (anchor.element) elements.add(anchor.element);
    }
  }
  for (const element of elements) element.classList.add("marked");
}

export function markChangeStops(root: ParentNode, stops: readonly number[]): void {
  for (const line of stops) {
    richDiffBlockForLine(root, line)?.setAttribute("data-diff-stop", "1");
  }
}

export function markRichGapContentAnchors(root: ParentNode, anchors: readonly { id: string; line: number }[]): void {
  for (const anchor of anchors) {
    const block = richDiffBlockForLine(root, anchor.line);
    if (!block) continue;
    const ids = new Set((block.dataset.richGapContentIds ?? "").split(/\s+/).filter(Boolean));
    ids.add(anchor.id);
    block.dataset.richGapContentIds = [...ids].join(" ");
  }
}

export function markRichInlineRanges(root: ParentNode, ranges: readonly RichInlineRange[]): void {
  const byElement = new Map<HTMLElement, RichInlineRange[]>();
  for (const range of ranges) {
    for (const element of richInlineCandidateElements(root, range)) {
      byElement.set(element, [...(byElement.get(element) ?? []), range]);
    }
  }
  for (const [element, elementRanges] of byElement) {
    const fallbackClasses = new Set<string>();
    if (!markTextChildrenInRanges(element, elementRanges)) {
      for (const range of elementRanges) fallbackClasses.add(`rich-inline-${range.kind}`);
    }
    for (const className of fallbackClasses) element.classList.add(className);
  }
}

export function richDiffBlockForLine(root: ParentNode, line: number): HTMLElement | null {
  return richDiffAnchorsForLine(root, line)[0]?.element ?? null;
}

function richDiffAnchorsForLine(root: ParentNode, line: number) {
  return renderedAnchorsForSourceLineRange(root, { from: line, to: line }, { maxDistance: 0 });
}

function richInlineCandidateElements(root: ParentNode, range: RichInlineRange): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-source-from][data-source-to]")]
    .filter((element) => sourceRange(element)?.overlaps(range))
    .filter((element) => ![...element.children].some((child) => child instanceof HTMLElement && sourceRange(child)?.overlaps(range)));
}

function markTextChildrenInRanges(element: HTMLElement, ranges: readonly RichInlineRange[]): boolean {
  const elementRange = sourceRange(element);
  if (!elementRange) return false;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text && walker.currentNode.data.length > 0) textNodes.push(walker.currentNode);
  }
  if (textNodes.length !== 1) return false;
  const text = textNodes[0];
  const localRanges = ranges
    .map((range) => ({
      start: Math.max(range.from, elementRange.from) - elementRange.from,
      end: Math.min(range.to, elementRange.to) - elementRange.from,
      kind: range.kind,
    }))
    .filter((range) => range.start >= 0 && range.end <= text.data.length && range.start < range.end)
    .sort((a, b) => b.start - a.start || b.end - a.end);
  if (localRanges.length === 0) return false;
  for (const range of localRanges) {
    const marker = document.createElement("span");
    marker.className = `rich-inline-${range.kind}`;
    const selected = text.splitText(range.start);
    selected.splitText(range.end - range.start);
    selected.parentNode?.replaceChild(marker, selected);
    marker.appendChild(selected);
  }
  return true;
}

function sourceRange(element: HTMLElement): { from: number; to: number; overlaps: (range: RichInlineRange) => boolean } | null {
  const from = Number(element.dataset.sourceFrom);
  const to = Number(element.dataset.sourceTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return {
    from,
    to,
    overlaps: (range) => from < range.to && range.from < to,
  };
}
