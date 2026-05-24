import { describe, expect, it } from "vitest";
import { diffLineNumbers } from "./diff-lines";

const patch = [
  "diff --git a/notes.md b/notes.md",
  "--- a/notes.md",
  "+++ b/notes.md",
  "@@ -1,3 +1,4 @@",
  " context",
  "-old line",
  "+new line",
  "+another new line",
  " tail",
  "\\ No newline at end of file",
  "@@ -10,3 +11,3 @@",
  " second context",
  "-removed later",
  "+added later",
].join("\n");

describe("diffLineNumbers", () => {
  it("returns added line numbers from parsed hunks", () => {
    expect(diffLineNumbers(patch, "added")).toEqual([2, 3, 12]);
  });

  it("returns removed line numbers from parsed hunks", () => {
    expect(diffLineNumbers(patch, "removed")).toEqual([2, 11]);
  });
});
