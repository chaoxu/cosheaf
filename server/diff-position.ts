// Bidirectional translation between Forgejo's diff `position` field and the
// (file_line, side) coordinate clients prefer. `position` is the 1-based
// offset within a hunk's content lines (counting +, -, and context lines
// uniformly, but skipping the `\ No newline at end of file` marker). It
// resets between hunks.
//
// We use `parse-diff` to tokenize hunks; the Forgejo-specific position math
// and the "skip the `\` marker" rule live here.

import { type ParsedChange, chunks } from "./diff-parse.js";

// PR-native side vocabulary: `head` = PR's head ref (added/context lines,
// right side of diff); `base` = PR's base ref (deleted lines, left side).
// Forgejo's review-comment write API uses `new_position` / `old_position`
// integers — head maps to new_position, base maps to old_position.
export type Side = "base" | "head";

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
        if (change.type === "add") return { line: newLine as number, side: "head" };
        if (change.type === "del") return { line: oldLine as number, side: "base" };
        return { line: newLine as number, side: "head" };
      }
    }
  }
  return null;
}

// Resolve a Forgejo review comment to its (line, side, outdated) display
// coordinates — shared by the typed comments API and the rich-diff renderer so
// the subtle invariant stays in lockstep: the line uses the fallback position
// (`position ?? original_position`), the side falls back by file status, but
// `outdated` keys on the RAW `position === null` (a comment whose anchor line is
// gone from the head). Pass `patch ?? ""` for a missing patch (→ no mapped line).
export function resolveLineComment(
  comment: { position: number | null; original_position: number | null },
  patch: string,
  status: string,
): { line: number | null; side: Side; outdated: boolean } {
  const pos = comment.position ?? comment.original_position;
  const mapped = pos === null ? null : positionToFileLine(patch, pos);
  return {
    line: mapped?.line ?? null,
    side: mapped?.side ?? (status === "deleted" ? "base" : "head"),
    outdated: comment.position === null,
  };
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
      if (side === "head" && newLine === line) return { new_position: position };
      if (side === "base" && oldLine === line) return { old_position: position };
    }
  }
  return null;
}
