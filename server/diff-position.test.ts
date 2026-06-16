import { describe, expect, it } from "vitest";
import { fileLineToWritePosition, resolveLineComment } from "./diff-position.js";

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

// body → file lines:
//  context-one  → old 1 / new 1
//  -old-two     → old 2
//  +new-two     → new 2
//  +new-three   → new 3
//  context-three→ old 3 / new 4
//  context-four → old 4 / new 5
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

describe("fileLineToWritePosition (Forgejo wants absolute file lines)", () => {
  it("returns null for empty patch / invalid line", () => {
    expect(fileLineToWritePosition("", 1, "head")).toBeNull();
    expect(fileLineToWritePosition(addedFile, 0, "head")).toBeNull();
  });

  it("emits the file line itself for a pure-added file (head side)", () => {
    expect(fileLineToWritePosition(addedFile, 1, "head")).toEqual({ new_position: 1 });
    expect(fileLineToWritePosition(addedFile, 3, "head")).toEqual({ new_position: 3 });
  });

  it("emits the head file line after a deletion (the off-by-N case the bug got wrong)", () => {
    // +new-two is head file line 2, +new-three is line 3 — even though a deletion
    // precedes them in the hunk body. The old code returned the hunk offset (3, 4).
    expect(fileLineToWritePosition(modified, 2, "head")).toEqual({ new_position: 2 });
    expect(fileLineToWritePosition(modified, 3, "head")).toEqual({ new_position: 3 });
    expect(fileLineToWritePosition(modified, 5, "head")).toEqual({ new_position: 5 });
  });

  it("emits the base file line for the old side", () => {
    expect(fileLineToWritePosition(modified, 2, "base")).toEqual({ old_position: 2 }); // -old-two
    expect(fileLineToWritePosition(modified, 1, "base")).toEqual({ old_position: 1 }); // context-one
  });

  it("returns null when the (line, side) isn't present in the diff", () => {
    expect(fileLineToWritePosition(modified, 99, "head")).toBeNull();
    expect(fileLineToWritePosition(addedFile, 1, "base")).toBeNull(); // nothing on base
  });
});

describe("resolveLineComment (position/original_position are absolute file lines; 0 != null)", () => {
  it("maps a head-side comment from position", () => {
    expect(resolveLineComment({ position: 5, original_position: 0 }, "modified")).toEqual({
      line: 5,
      side: "head",
      outdated: false,
    });
  });

  it("maps a base-side comment from original_position when position is 0 (not outdated — no freshness signal)", () => {
    expect(resolveLineComment({ position: 0, original_position: 3 }, "modified")).toEqual({
      line: 3,
      side: "base",
      outdated: false,
    });
  });

  it("treats a fully-unanchored comment (both 0) as outdated, side seeded by status", () => {
    expect(resolveLineComment({ position: 0, original_position: 0 }, "modified")).toEqual({
      line: null,
      side: "head",
      outdated: true,
    });
    expect(resolveLineComment({ position: 0, original_position: 0 }, "deleted")).toEqual({
      line: null,
      side: "base",
      outdated: true,
    });
  });

  it("accepts null defensively (Forgejo sends 0, but be safe)", () => {
    expect(resolveLineComment({ position: null, original_position: null }, "modified")).toEqual({
      line: null,
      side: "head",
      outdated: true,
    });
  });
});
