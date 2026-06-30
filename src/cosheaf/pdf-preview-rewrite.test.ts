// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isPdfAssetPath, pdfDisplaySuffix } from "../../shared/asset-previews";
import { rewritePdfPreviewObjects } from "./pdf-preview-rewrite";

describe("pdfDisplaySuffix", () => {
  it("marks a PDF display URL for rasterization, leaves rasters alone", () => {
    expect(isPdfAssetPath("img/fig.pdf")).toBe(true);
    expect(isPdfAssetPath("img/fig.PDF")).toBe(true);
    expect(isPdfAssetPath("img/fig.png")).toBe(false);
    expect(pdfDisplaySuffix("img/fig.pdf")).toBe("?preview=png");
    expect(pdfDisplaySuffix("img/fig.png")).toBe("");
  });
});

describe("rewritePdfPreviewObjects", () => {
  it("swaps a PDF <object> for an <img> at the preview URL", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<span class="cf-image-wrapper"><object class="cf-image cf-pdf-preview" data="/o/r/raw/branch/main/fig.pdf?preview=png" type="application/pdf" aria-label="my figure"></object></span>';
    rewritePdfPreviewObjects(root);
    expect(root.querySelector("object")).toBeNull();
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/o/r/raw/branch/main/fig.pdf?preview=png");
    expect(img?.className).toContain("cf-image");
    expect(img?.getAttribute("alt")).toBe("my figure");
  });

  it("leaves regular images and non-PDF objects untouched", () => {
    const root = document.createElement("div");
    root.innerHTML = '<img class="cf-image" src="/x.png"><object class="other" data="/y"></object>';
    rewritePdfPreviewObjects(root);
    expect(root.querySelectorAll("img").length).toBe(1);
    expect(root.querySelector("object.other")).not.toBeNull();
  });
});
