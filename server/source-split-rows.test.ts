import { describe, expect, it } from "vitest";
import { sourceSplitRows } from "./source-split-rows.js";

describe("sourceSplitRows", () => {
  it("aligns unchanged, deleted, and added lines for split source diffs", () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,4 @@",
      " # bandits",
      " ",
      "-K-armed bandits with possibly biased offline data",
      "+Resolve the following research problem.",
      "+More detail.",
    ].join("\n");

    expect(sourceSplitRows(patch)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
      {
        kind: "pair",
        base: { side: "base", line: 1, text: "# bandits", kind: "ctx" },
        head: { side: "head", line: 1, text: "# bandits", kind: "ctx" },
      },
      {
        kind: "pair",
        base: { side: "base", line: 2, text: "", kind: "ctx" },
        head: { side: "head", line: 2, text: "", kind: "ctx" },
      },
      {
        kind: "pair",
        base: { side: "base", line: 3, text: "K-armed bandits with possibly biased offline data", kind: "del" },
        head: { side: "head", line: 3, text: "Resolve the following research problem.", kind: "add" },
      },
      {
        kind: "pair",
        base: null,
        head: { side: "head", line: 4, text: "More detail.", kind: "add" },
      },
    ]);
  });

  it("renders pure insertions as empty base cells", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,1 +1,2 @@",
      " one",
      "+two",
    ].join("\n");

    expect(sourceSplitRows(patch).at(-1)).toEqual({
      kind: "pair",
      base: null,
      head: { side: "head", line: 2, text: "two", kind: "add" },
    });
  });
});
