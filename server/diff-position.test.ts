import { describe, it, expect } from "vitest";
import { fileLineToWritePosition, positionToFileLine } from "./diff-position.js";

const addedFile = [
  "diff --git a/new.md b/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.md",
  "@@ -0,0 +1,3 @@",
  "+alpha",
  "+beta",
  "+gamma",
].join("\n");

const modified = [
  "diff --git a/a.md b/a.md",
  "--- a/a.md",
  "+++ b/a.md",
  "@@ -1,4 +1,5 @@",
  " context-one",
  "-old-two",
  "+new-two",
  "+new-three",
  " context-three",
  " context-four",
].join("\n");

const multiHunk = [
  "diff --git a/a.md b/a.md",
  "--- a/a.md",
  "+++ b/a.md",
  "@@ -1,2 +1,3 @@",
  " ctx",
  "+inserted",
  " trailing",
  "@@ -10,2 +11,3 @@",
  " more-ctx",
  "+second-insert",
  " more-trailing",
].join("\n");

describe("positionToFileLine", () => {
  it("returns null on empty input", () => {
    expect(positionToFileLine("", 1)).toBeNull();
    expect(positionToFileLine(addedFile, 0)).toBeNull();
    expect(positionToFileLine(addedFile, 99)).toBeNull();
  });

  it("maps a pure-added file (Forgejo: @@ -0,0 +1,3 @@)", () => {
    expect(positionToFileLine(addedFile, 1)).toEqual({ line: 1, side: "head" });
    expect(positionToFileLine(addedFile, 2)).toEqual({ line: 2, side: "head" });
    expect(positionToFileLine(addedFile, 3)).toEqual({ line: 3, side: "head" });
  });

  it("maps mixed +/- with context", () => {
    // body lines:
    // 1: " context-one"  → new line 1, side derived from caller (context = new)
    // 2: "-old-two"      → old line 2
    // 3: "+new-two"      → new line 2
    // 4: "+new-three"    → new line 3
    // 5: " context-three"→ new line 4
    // 6: " context-four" → new line 5
    expect(positionToFileLine(modified, 1)).toEqual({ line: 1, side: "head" });
    expect(positionToFileLine(modified, 2)).toEqual({ line: 2, side: "base" });
    expect(positionToFileLine(modified, 3)).toEqual({ line: 2, side: "head" });
    expect(positionToFileLine(modified, 4)).toEqual({ line: 3, side: "head" });
    expect(positionToFileLine(modified, 5)).toEqual({ line: 4, side: "head" });
    expect(positionToFileLine(modified, 6)).toEqual({ line: 5, side: "head" });
  });

  it("position numbering restarts per hunk", () => {
    // First hunk body has 3 lines, second hunk body has 3 lines.
    // Position 1 in *first* hunk = line 1 new.
    // Position 1 should NOT silently address the second hunk.
    expect(positionToFileLine(multiHunk, 1)).toEqual({ line: 1, side: "head" });
    expect(positionToFileLine(multiHunk, 2)).toEqual({ line: 2, side: "head" });
    expect(positionToFileLine(multiHunk, 3)).toEqual({ line: 3, side: "head" });
  });
});

describe("fileLineToWritePosition", () => {
  it("maps lines in an added file", () => {
    expect(fileLineToWritePosition(addedFile, 1, "head")).toEqual({ new_position: 1 });
    expect(fileLineToWritePosition(addedFile, 3, "head")).toEqual({ new_position: 3 });
    expect(fileLineToWritePosition(addedFile, 1, "base")).toBeNull();
  });

  it("maps old-side lines", () => {
    expect(fileLineToWritePosition(modified, 2, "base")).toEqual({ old_position: 2 });
  });

  it("maps new-side lines including context", () => {
    expect(fileLineToWritePosition(modified, 1, "head")).toEqual({ new_position: 1 });
    expect(fileLineToWritePosition(modified, 2, "head")).toEqual({ new_position: 3 });
    expect(fileLineToWritePosition(modified, 3, "head")).toEqual({ new_position: 4 });
    expect(fileLineToWritePosition(modified, 5, "head")).toEqual({ new_position: 6 });
  });

  it("returns null for lines outside the patch", () => {
    expect(fileLineToWritePosition(modified, 999, "head")).toBeNull();
    // Old-side line 2 was deleted, so commenting on old-2 is valid; check
    // an absent old-side line instead.
    expect(fileLineToWritePosition(modified, 999, "base")).toBeNull();
  });
});

describe("round-trip", () => {
  it("position → (line, side) → position is identity for body positions in modified", () => {
    for (let p = 1; p <= 6; p++) {
      const mapped = positionToFileLine(modified, p);
      if (!mapped) throw new Error(`position ${p} did not map`);
      const back = fileLineToWritePosition(modified, mapped.line, mapped.side);
      if (!back) throw new Error(`line ${mapped.line}/${mapped.side} did not map back`);
      const recovered = back.new_position ?? back.old_position;
      expect(recovered).toBe(p);
    }
  });
});
