import { renderedAnchorsForSourceLineRange } from "@chaoxu/coflat/reader";

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

export function richDiffBlockForLine(root: ParentNode, line: number): HTMLElement | null {
  return richDiffAnchorsForLine(root, line)[0]?.element ?? null;
}

function richDiffAnchorsForLine(root: ParentNode, line: number) {
  return renderedAnchorsForSourceLineRange(root, { from: line, to: line }, { maxDistance: 0 });
}
