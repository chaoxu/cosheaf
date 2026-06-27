import { diffWordsWithSpace, type Change } from "diff";

export type SourceInlineDiffKind = "same" | "del" | "add";

export interface SourceInlineDiffSegment {
  kind: SourceInlineDiffKind;
  text: string;
}

export interface SourceInlineDiff {
  base: SourceInlineDiffSegment[];
  head: SourceInlineDiffSegment[];
}

export interface SourceInlineDiffRange {
  from: number;
  to: number;
  kind: "del" | "add";
}

export interface SourceInlineDiffRanges {
  base: SourceInlineDiffRange[];
  head: SourceInlineDiffRange[];
}

export function sourceInlineDiff(base: string, head: string): SourceInlineDiff {
  const changes = diffWordsWithSpace(base, head);
  return {
    base: segmentsForSide(changes, "base"),
    head: segmentsForSide(changes, "head"),
  };
}

export function sourceInlineDiffRanges(base: string, head: string): SourceInlineDiffRanges {
  const changes = diffWordsWithSpace(base, head);
  return {
    base: rangesForSide(changes, "base"),
    head: rangesForSide(changes, "head"),
  };
}

function segmentsForSide(changes: readonly Change[], side: "base" | "head"): SourceInlineDiffSegment[] {
  const filtered = side === "base"
    ? changes.filter((change) => !change.added)
    : changes.filter((change) => !change.removed);
  return collapseSegments(filtered.map((change) => segment(change, side === "base" ? "del" : "add")));
}

function segment(change: Change, changedKind: "del" | "add"): SourceInlineDiffSegment {
  return { kind: change.added || change.removed ? changedKind : "same", text: change.value };
}

function collapseSegments(segments: readonly SourceInlineDiffSegment[]): SourceInlineDiffSegment[] {
  const out: SourceInlineDiffSegment[] = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (last?.kind === segment.kind) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

function rangesForSide(changes: readonly Change[], side: "base" | "head"): SourceInlineDiffRange[] {
  const ranges: SourceInlineDiffRange[] = [];
  let offset = 0;
  for (const change of changes) {
    if (side === "base" && change.added) continue;
    if (side === "head" && change.removed) continue;
    const nextOffset = offset + change.value.length;
    if ((side === "base" && change.removed) || (side === "head" && change.added)) {
      ranges.push({ from: offset, to: nextOffset, kind: side === "base" ? "del" : "add" });
    }
    offset = nextOffset;
  }
  return ranges.filter((range) => range.to > range.from);
}
