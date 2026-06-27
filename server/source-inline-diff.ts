export type SourceInlineDiffKind = "same" | "del" | "add";

export interface SourceInlineDiffSegment {
  kind: SourceInlineDiffKind;
  text: string;
}

const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;

export function sourceInlineDiff(base: string, head: string): { base: SourceInlineDiffSegment[]; head: SourceInlineDiffSegment[] } {
  const baseTokens = tokenize(base);
  const headTokens = tokenize(head);
  const common = lcs(baseTokens, headTokens);
  return {
    base: collapseSegments(markUnmatched(baseTokens, common, "del")),
    head: collapseSegments(markUnmatched(headTokens, common, "add")),
  };
}

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

function lcs(a: readonly string[], b: readonly string[]): string[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

function markUnmatched(tokens: readonly string[], common: readonly string[], changedKind: "del" | "add"): SourceInlineDiffSegment[] {
  const out: SourceInlineDiffSegment[] = [];
  let commonIndex = 0;
  for (const token of tokens) {
    if (commonIndex < common.length && token === common[commonIndex]) {
      out.push({ kind: "same", text: token });
      commonIndex += 1;
    } else {
      out.push({ kind: changedKind, text: token });
    }
  }
  return out;
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
