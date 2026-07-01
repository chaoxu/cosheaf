import { describe, expect, it } from "vitest";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { fileTreePanel } from "./web-file-tree.js";

const files = [
  { path: "intro.md", type: "blob", size: 1 },
  { path: "docs/guide.md", type: "blob", size: 1 },
] as unknown as ForgejoTreeEntry[];

describe("fileTreePanel", () => {
  it("renders active files, ancestor directories, and Markdown title labels", () => {
    const out = String(
      fileTreePanel(
        "chao",
        "flushing-coin",
        "main",
        files,
        "docs/guide.md",
        new Map([["intro.md", "Introduction"]]),
      ),
    );

    expect(out).toContain('class="file-tree"');
    expect(out).toContain("ftree-file active");
    expect(out).toContain('<details class="ftree-dir" open>');
    expect(out).toContain('<span class="ftree-title">Introduction</span>');
    expect(out).toContain('<span class="ftree-name">intro.md</span>');
    expect(out).toContain("guide.md");
  });
});
