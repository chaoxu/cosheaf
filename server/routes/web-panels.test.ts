import { describe, expect, it } from "vitest";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { fileTreePanel } from "./web-file-tree.js";
import { html } from "./web-html.js";
import { panel, renderRegion } from "./web-panels.js";
import { threadLayout } from "./web-thread.js";

const files = [
  { path: "intro.md", type: "blob", size: 1 },
  { path: "docs/guide.md", type: "blob", size: 1 },
] as unknown as ForgejoTreeEntry[];

describe("web-panels portability seam (#120)", () => {
  it("renderRegion renders each panel's own content, in order", () => {
    const out = String(
      renderRegion([
        panel("a", () => html`<p class="x">A</p>`),
        panel("b", () => html`<p class="y">B</p>`),
      ]),
    );
    expect(out).toContain('class="x"');
    expect(out).toContain('class="y"');
    expect(out.indexOf("A")).toBeLessThan(out.indexOf("B"));
  });

  it("a panel renders identically whether placed in the sidebar region or the thread rail (no container coupling)", () => {
    const tree = fileTreePanel("chao", "flushing-coin", "main", files, "docs/guide.md");

    // Same panel, two different regions: the sidebar region (renderRegion alone)
    // and the thread rail region (threadLayout's <aside class="thread-rail">).
    const inSidebar = String(renderRegion([tree]));
    const inRail = String(threadLayout(html`<p>main</p>`, [tree]));

    // The panel owns only its own content (.file-tree nav) — it appears
    // unchanged in both regions; only the region-provided wrapper differs.
    for (const region of [inSidebar, inRail]) {
      expect(region).toContain('class="file-tree"');
      expect(region).toContain("intro.md");
      expect(region).toContain("guide.md");
      // active file highlighted + ancestor dir auto-open, regardless of region
      expect(region).toContain("ftree-file active");
      expect(region).toContain('<details class="ftree-dir" open>');
    }
    // Only the rail adds its container wrapper; the panel content is identical.
    expect(inRail).toContain('class="thread-rail"');
    expect(inSidebar).not.toContain('class="thread-rail"');
  });

  it("renders filename and Markdown title labels for the user label preference", () => {
    const tree = fileTreePanel(
      "chao",
      "flushing-coin",
      "main",
      files,
      null,
      new Map([["intro.md", "Introduction"]]),
    );
    const out = String(renderRegion([tree]));

    expect(out).toContain('<span class="ftree-title">Introduction</span>');
    expect(out).toContain('<span class="ftree-name">intro.md</span>');
    expect(out).toContain("guide.md");
  });
});
