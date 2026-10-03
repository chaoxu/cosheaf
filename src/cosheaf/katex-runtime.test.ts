import katex from "katex";
import { describe, expect, it } from "vitest";

describe("host KaTeX runtime", () => {
  it("preserves Coflat source locations in the host-provided dependency", () => {
    const html = katex.renderToString("x", { output: "html" });
    expect(html).toContain('data-loc-start="0"');
    expect(html).toContain('data-loc-end="1"');
  });
});
