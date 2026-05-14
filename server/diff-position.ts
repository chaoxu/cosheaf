// Bidirectional translation between Forgejo's diff `position` field and the
// (file_line, side) coordinate clients prefer. `position` is the 1-based
// offset within a hunk's content lines (counting +, -, and context lines
// uniformly, but skipping the `\ No newline at end of file` marker). It
// resets between hunks.
//
// We use `parse-diff` to tokenize hunks; the Forgejo-specific position math
// and the "skip the `\` marker" rule live here.

import parseDiffLib from "parse-diff";

export type Side = "new" | "old";

interface ParsedChange {
  type: "add" | "del" | "normal";
  ln1?: number; // old-side line (set on del + normal)
  ln2?: number; // new-side line (set on add + normal)
  ln?: number;
  content: string;
}

interface ParsedChunk {
  changes: ParsedChange[];
}

function chunks(patch: string): ParsedChunk[] {
  if (!patch) return [];
  // parse-diff is loose about input — accepting bare hunks (no `diff --git`
  // header) works fine.
  const parsed = (parseDiffLib as unknown as (s: string) => Array<{ chunks: ParsedChunk[] }>)(patch);
  return parsed.flatMap((f) => f.chunks ?? []);
}

function changeLines(c: ParsedChange): { oldLine: number | null; newLine: number | null } {
  if (c.type === "add") return { oldLine: null, newLine: c.ln ?? null };
  if (c.type === "del") return { oldLine: c.ln ?? null, newLine: null };
  return { oldLine: c.ln1 ?? null, newLine: c.ln2 ?? null };
}

// Position → (line, side).
// Returns null when the position is out of range or not part of any hunk body.
export function positionToFileLine(patch: string, position: number): { line: number; side: Side } | null {
  if (!patch || position < 1) return null;
  for (const hunk of chunks(patch)) {
    let offset = 0;
    for (const change of hunk.changes) {
      if (change.content.startsWith("\\")) continue; // skip "\ No newline at end of file"
      offset++;
      if (offset === position) {
        const { oldLine, newLine } = changeLines(change);
        if (change.type === "add") return { line: newLine as number, side: "new" };
        if (change.type === "del") return { line: oldLine as number, side: "old" };
        return { line: newLine as number, side: "new" };
      }
    }
  }
  return null;
}

// (line, side) → write payload for `CreatePullReviewComment`.
// Returns the right `{ new_position }` or `{ old_position }` field, or null
// if (line, side) isn't in the patch.
export function fileLineToWritePosition(
  patch: string,
  line: number,
  side: Side,
): { new_position?: number; old_position?: number } | null {
  if (!patch || line < 1) return null;
  for (const hunk of chunks(patch)) {
    let position = 0;
    for (const change of hunk.changes) {
      if (change.content.startsWith("\\")) continue;
      position++;
      const { oldLine, newLine } = changeLines(change);
      if (side === "new" && newLine === line) return { new_position: position };
      if (side === "old" && oldLine === line) return { old_position: position };
    }
  }
  return null;
}
