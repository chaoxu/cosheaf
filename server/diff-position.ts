// Bidirectional translation between Forgejo's diff `position` field and the
// (file_line, side) coordinate clients prefer.
//
// `position` is the 1-based offset within a hunk's content lines (counting +,
// -, and context lines uniformly). The first content line after a `@@ … @@`
// header is position 1; the line after that is position 2; etc. Position
// resets between hunks (so the same number can appear in multiple hunks of
// the same file). See server/diff-position.test.ts for fixtures.
//
// `side` is not present in Forgejo's response. We derive it from the line's
// prefix in the patch: `+` → new, `-` → old, context (` `) is on both.

export type Side = "new" | "old";

interface HunkHeader {
  oldStart: number;
  newStart: number;
  /** Index of the line *after* the `@@` header in the patch split. */
  bodyStart: number;
  /** Exclusive index of the last body line; falls back to patch end. */
  bodyEnd: number;
}

function scanHunks(patch: string): { lines: string[]; hunks: HunkHeader[] } {
  const lines = patch.split("\n");
  const hunks: HunkHeader[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      newStart: Number(m[2]),
      bodyStart: i + 1,
      bodyEnd: lines.length,
    });
  }
  for (let h = 0; h < hunks.length - 1; h++) hunks[h].bodyEnd = hunks[h + 1].bodyStart - 1;
  return { lines, hunks };
}

// Position → (line, side).
// Returns null when the patch has no hunks, the position is out of range, or
// the addressed line is not part of any hunk body.
export function positionToFileLine(patch: string, position: number): { line: number; side: Side } | null {
  if (!patch || position < 1) return null;
  const { lines, hunks } = scanHunks(patch);

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let offset = 0;
    for (let i = hunk.bodyStart; i < hunk.bodyEnd; i++) {
      const raw = lines[i];
      // Skip the "\ No newline at end of file" marker — it isn't counted.
      if (raw.startsWith("\\")) continue;
      offset++;
      if (offset === position) {
        if (raw.startsWith("+")) return { line: newLine, side: "new" };
        if (raw.startsWith("-")) return { line: oldLine, side: "old" };
        return { line: newLine, side: "new" };
      }
      if (raw.startsWith("+")) newLine++;
      else if (raw.startsWith("-")) oldLine++;
      else {
        oldLine++;
        newLine++;
      }
    }
    // Position numbering restarts in the next hunk, so don't carry across.
    if (offset >= position) break;
  }
  return null;
}

// (line, side) → write payload for `CreatePullReviewComment`.
// Forgejo accepts `new_position` OR `old_position` (mutually exclusive). The
// caller picks the side; we hand back the right field and value, or null if
// the (line, side) doesn't appear in the patch.
export function fileLineToWritePosition(
  patch: string,
  line: number,
  side: Side,
): { new_position?: number; old_position?: number } | null {
  if (!patch || line < 1) return null;
  const { lines, hunks } = scanHunks(patch);

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    let position = 0;
    for (let i = hunk.bodyStart; i < hunk.bodyEnd; i++) {
      const raw = lines[i];
      if (raw.startsWith("\\")) continue;
      position++;
      const onNew = raw.startsWith("+") || !raw.startsWith("-");
      const onOld = raw.startsWith("-") || !raw.startsWith("+");
      if (side === "new" && onNew && newLine === line) {
        return { new_position: position };
      }
      if (side === "old" && onOld && oldLine === line) {
        return { old_position: position };
      }
      if (raw.startsWith("+")) newLine++;
      else if (raw.startsWith("-")) oldLine++;
      else {
        oldLine++;
        newLine++;
      }
    }
  }
  return null;
}
