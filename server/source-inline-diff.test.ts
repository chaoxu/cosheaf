import { describe, expect, it } from "vitest";
import { sourceInlineDiff, sourceInlineDiffRanges } from "./source-inline-diff.js";

describe("sourceInlineDiff", () => {
  it("marks only changed tokens inside paired replacement lines", () => {
    expect(sourceInlineDiff("The quick brown fox.", "The quick red fox.")).toEqual({
      base: [
        { kind: "same", text: "The quick " },
        { kind: "del", text: "brown" },
        { kind: "same", text: " fox." },
      ],
      head: [
        { kind: "same", text: "The quick " },
        { kind: "add", text: "red" },
        { kind: "same", text: " fox." },
      ],
    });
  });

  it("keeps punctuation and whitespace stable when possible", () => {
    expect(sourceInlineDiff("See [@sec:q1].", "See [@sec:q2].")).toEqual({
      base: [
        { kind: "same", text: "See [@sec:" },
        { kind: "del", text: "q1" },
        { kind: "same", text: "]." },
      ],
      head: [
        { kind: "same", text: "See [@sec:" },
        { kind: "add", text: "q2" },
        { kind: "same", text: "]." },
      ],
    });
  });

  it("keeps whitespace-only edits visible", () => {
    expect(sourceInlineDiff("alpha beta", "alpha  beta")).toEqual({
      base: [
        { kind: "same", text: "alpha" },
        { kind: "del", text: " " },
        { kind: "same", text: "beta" },
      ],
      head: [
        { kind: "same", text: "alpha" },
        { kind: "add", text: "  " },
        { kind: "same", text: "beta" },
      ],
    });
  });

  it("keeps HTML-looking text as plain segment text for the renderer to escape", () => {
    expect(sourceInlineDiff("x < y", "x <= y")).toEqual({
      base: [{ kind: "same", text: "x < y" }],
      head: [
        { kind: "same", text: "x <" },
        { kind: "add", text: "=" },
        { kind: "same", text: " y" },
      ],
    });
  });

  it("returns local line ranges for rich inline highlighting", () => {
    expect(sourceInlineDiffRanges("The quick brown fox.", "The quick red fox.")).toEqual({
      base: [{ from: 10, to: 15, kind: "del" }],
      head: [{ from: 10, to: 13, kind: "add" }],
    });
  });
});
