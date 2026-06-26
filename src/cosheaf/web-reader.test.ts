import { describe, expect, it } from "vitest";
import {
  _inferRichDiffSourceRangesForTest,
  _richDiffRangeIndexForLineForTest,
  _richDiffSourceRangeForDatasetForTest,
} from "./reader-diff-marking";

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

  it("uses source line instead of source character offsets for rich diff markers", () => {
    expect(_richDiffSourceRangeForDatasetForTest({
      sourceLine: "67",
      sourceFrom: "3440",
      sourceTo: "3476",
    })).toEqual({ from: 67, to: 67, explicitTo: false });
  });

  it("maps continuation lines to the preceding rich diff block", () => {
    expect(_richDiffRangeIndexForLineForTest([
      { from: 67 },
      { from: 71 },
    ], 69)).toBe(0);
  });
});
