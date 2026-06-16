import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { iconMarkup, lucideIcons } from "../../shared/lucide.js";
import { branchIcon, eyeIcon } from "./icons.js";

describe("iconMarkup (shared lucide source #186)", () => {
  it("renders an aria-hidden lucide SVG sized from opts, with the node's children", () => {
    const svg = iconMarkup(lucideIcons.branch, { size: 13 });
    expect(svg).toContain('class="lucide"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('width="13"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("<path"); // git-branch carries a path child
  });
  it("appends and escapes a class option", () => {
    expect(iconMarkup(lucideIcons.eye, { class: 'x"y' })).toContain('class="lucide x&quot;y"');
  });
  it("server helpers wrap the same markup as Html", () => {
    expect(String(branchIcon())).toBe(iconMarkup(lucideIcons.branch));
    expect(String(eyeIcon({ size: 14 }))).toBe(iconMarkup(lucideIcons.eye, { size: 14 }));
  });
});

describe("cosheaf-select.js branch glyph stays in lockstep with the shared lucide source (#186 drift guard)", () => {
  // cosheaf-select.js is a plain, non-module <script>, so it can't import
  // shared/lucide.ts and hand-copies the git-branch geometry. Fail loudly if
  // lucide's node data changes so the copy can't silently drift.
  it("contains every git-branch path/circle value from shared/lucide.ts", () => {
    const file = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/cosheaf-select.js"),
      "utf8",
    );
    for (const [, attrs] of lucideIcons.branch) {
      for (const value of Object.values(attrs)) {
        expect(file).toContain(String(value));
      }
    }
  });
});
