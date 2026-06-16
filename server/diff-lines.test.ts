import { describe, expect, it } from "vitest";
import { changedLines, commentableLines, patchRows } from "./diff-lines.js";

const patch = [
  "diff --git a/a.md b/a.md",
  "--- a/a.md",
  "+++ b/a.md",
  "@@ -1,3 +1,4 @@",
  " context-one",
  "-old-two",
  "+new-two",
  "+new-three",
  " context-three",
  "\\ No newline at end of file",
  "@@ -10,2 +11,2 @@",
  " later-context",
  "-old-later",
  "+new-later",
].join("\n");

describe("server diff line helpers", () => {
  it("returns changed old/new line sets from parsed hunks", () => {
    const changed = changedLines(patch);
    expect([...changed.added]).toEqual([2, 3, 12]);
    expect([...changed.deleted]).toEqual([2, 11]);
  });

  it("returns lines that can receive comments on each side", () => {
    const commentable = commentableLines(patch);
    expect([...commentable.head]).toEqual([1, 2, 3, 4, 11, 12]);
    expect([...commentable.base]).toEqual([1, 2, 3, 10, 11]);
  });

  it("renders source diff rows without git metadata", () => {
    expect(patchRows(patch).map((row) => [row.kind, row.sign, row.text])).toEqual([
      ["hunk", "@", "@ -1,3 +1,4 @@"],
      ["ctx", " ", "context-one"],
      ["del", "-", "old-two"],
      ["add", "+", "new-two"],
      ["add", "+", "new-three"],
      ["ctx", " ", "context-three"],
      ["hunk", "@", "@ -10,2 +11,2 @@"],
      ["ctx", " ", "later-context"],
      ["del", "-", "old-later"],
      ["add", "+", "new-later"],
    ]);
  });
});
