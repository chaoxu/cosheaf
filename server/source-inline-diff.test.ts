import { describe, expect, it } from "vitest";
import { sourceInlineDiff } from "./source-inline-diff.js";

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
});
