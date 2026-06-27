import { diffWordsWithSpace, type Change } from "diff";

export type SourceInlineDiffKind = "same" | "del" | "add";

export interface SourceInlineDiffSegment {
  kind: SourceInlineDiffKind;
  text: string;
}

export function sourceInlineDiff(base: string, head: string): { base: SourceInlineDiffSegment[]; head: SourceInlineDiffSegment[] } {
  const changes = diffWordsWithSpace(base, head);
  return {
    base: collapseSegments(changes.filter((change) => !change.added).map((change) => segment(change, "del"))),
    head: collapseSegments(changes.filter((change) => !change.removed).map((change) => segment(change, "add"))),
  };
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
