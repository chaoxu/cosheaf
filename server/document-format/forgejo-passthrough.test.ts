import { describe, expect, it } from "vitest";
import { forgejoPassthroughFormat } from "./forgejo-passthrough.js";

describe("forgejoPassthroughFormat", () => {
  it("parses frontmatter and extracts no backlinks", () => {
    const parsed = forgejoPassthroughFormat.parseDocument(
      "---\nid: p\ntitle: Page\n---\n# Page\n\nSee [@coflat] and [other](other.md).\n",
    );

    expect(parsed.frontmatter).toMatchObject({ id: "p", title: "Page" });
    expect(parsed.body).toContain("See [@coflat]");
    expect(forgejoPassthroughFormat.extractTitle(parsed.body)).toBe("Page");
    expect(forgejoPassthroughFormat.extractLinks(parsed.body)).toEqual([]);
  });
});
