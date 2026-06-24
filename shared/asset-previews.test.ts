import { describe, expect, it } from "vitest";
import { buildPdfImagePreviewPaths, previewAssetPath } from "./asset-previews.js";

describe("buildPdfImagePreviewPaths", () => {
  it("maps PDF figures to same-basename browser image previews", () => {
    expect(buildPdfImagePreviewPaths([
      "figures/pipeline.pdf",
      "figures/pipeline.png",
      "figures/pipeline.tex",
      "figures/lowerbound.PDF",
      "figures/lowerbound.webp",
      "other/pipeline.png",
    ])).toEqual({
      "figures/lowerbound.PDF": "figures/lowerbound.webp",
      "figures/pipeline.pdf": "figures/pipeline.png",
    });
  });

  it("leaves PDFs without a sibling image preview alone", () => {
    const previews = buildPdfImagePreviewPaths(["figures/only.pdf", "figures/only.tex"]);
    expect(previews).toEqual({});
    expect(previewAssetPath("figures/only.pdf", previews)).toBe("figures/only.pdf");
  });
});
