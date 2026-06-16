// Forgejo review-comment coordinates. Forgejo's `position` is the absolute file
// line on the HEAD/new side (0 — not null — when the comment is not anchored on
// the head side), and `original_position` is the absolute line on the BASE/old
// side. The create API's `new_position` / `old_position` are likewise absolute
// file lines. (Verified live against Forgejo 15: posting new_position=5 anchors
// to head file line 5 and reads back position=5, original_position=0 — the value
// is NOT a hunk-relative or cumulative diff offset.)
//
// We use `parse-diff` to tokenize hunks only to validate that a (line, side) is
// actually present in the diff before writing.

import { type ParsedChange, chunks } from "./diff-parse.js";

// PR-native side vocabulary: `head` = PR's head ref (added/context lines, right
// side of the diff); `base` = PR's base ref (deleted lines, left side). Forgejo's
// review-comment write API uses `new_position` (head) / `old_position` (base).
export type Side = "base" | "head";

function changeLines(c: ParsedChange): { oldLine: number | null; newLine: number | null } {
  if (c.type === "add") return { oldLine: null, newLine: c.ln ?? null };
  if (c.type === "del") return { oldLine: c.ln ?? null, newLine: null };
  return { oldLine: c.ln1 ?? null, newLine: c.ln2 ?? null };
}

// Resolve a Forgejo review comment to its (line, side, outdated) display
// coordinates. `position > 0` → the comment is on the head side at that file
// line. Otherwise it is anchored to the base side at `original_position`; a
// comment with no live head anchor (`position === 0`) is shown as outdated.
// `status` only seeds the side when neither anchor is present (a wholly-removed
// file). Forgejo serializes these as plain integers (0, never null) but we accept
// null defensively.
export function resolveLineComment(
  comment: { position: number | null; original_position: number | null },
  status: string,
): { line: number | null; side: Side; outdated: boolean } {
  const position = comment.position ?? 0;
  const original = comment.original_position ?? 0;
  if (position > 0) return { line: position, side: "head", outdated: false };
  if (original > 0) return { line: original, side: "base", outdated: true };
  return { line: null, side: status === "deleted" ? "base" : "head", outdated: true };
}

// (line, side) → write payload for `CreatePullReviewComment`. Forgejo wants the
// absolute file line, so emit it directly — but only after confirming (line,
// side) is actually present in the diff (an added/context line on head, a
// deleted/context line on base); return null otherwise so callers don't post a
// comment onto a line the diff doesn't cover.
export function fileLineToWritePosition(
  patch: string,
  line: number,
  side: Side,
): { new_position?: number; old_position?: number } | null {
  if (!patch || line < 1) return null;
  for (const hunk of chunks(patch)) {
    for (const change of hunk.changes) {
      if (change.content.startsWith("\\")) continue; // "\ No newline at end of file"
      const { oldLine, newLine } = changeLines(change);
      if (side === "head" && newLine === line) return { new_position: line };
      if (side === "base" && oldLine === line) return { old_position: line };
    }
  }
  return null;
}
