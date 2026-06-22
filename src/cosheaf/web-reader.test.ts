import { describe, expect, it } from "vitest";
import { _inferRichDiffSourceRangesForTest } from "./reader-diff-marking";

describe("rich diff source range inference", () => {
  it("extends single-line block attribution until the next attributed block", () => {
    expect(_inferRichDiffSourceRangesForTest([
      { from: 102 },
      { from: 103 },
      { from: 104 },
      { from: 109 },
    ])).toEqual([
      { from: 102, to: 102 },
      { from: 103, to: 103 },
      { from: 104, to: 108 },
      { from: 109, to: 109 },
    ]);
  });

  it("keeps explicit source ranges intact", () => {
    expect(_inferRichDiffSourceRangesForTest([
      { from: 104, to: 104 },
      { from: 110, to: 113, explicitTo: true },
      { from: 115 },
    ])).toEqual([
      { from: 104, to: 109 },
      { from: 110, to: 113 },
      { from: 115, to: 115 },
    ]);
  });
});
