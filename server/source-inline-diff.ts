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

export function sourceInlineDiff(base: string, head: string): SourceInlineDiff {
  const changes = diffWordsWithSpace(base, head);
  return {
    base: segmentsForSide(changes, "base"),
    head: segmentsForSide(changes, "head"),
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
