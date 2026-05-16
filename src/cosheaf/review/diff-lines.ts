// Walks a unified-diff patch and produces, for each `+` (or `-`) line, the
// absolute line number on the new or old side respectively. Used by the tint
// renderer to know which lines to highlight.

export function diffLineNumbers(patch: string, kind: "added" | "removed"): number[] {
  if (!patch) return [];
  const matcher = kind === "added" ? "+" : "-";
  const advanceOnContext = true;
  const headerGroup = kind === "added" ? 2 : 1;
  const out: number[] = [];
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[headerGroup]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const ch = raw[0];
    if (ch === matcher) {
      out.push(line);
      line++;
    } else if (ch === "+" || ch === "-") {
      // Other side: this line is absent on our side; don't advance.
    } else if (advanceOnContext) {
      // Context line — present on both sides.
      line++;
    }
  }
  return out;
}
