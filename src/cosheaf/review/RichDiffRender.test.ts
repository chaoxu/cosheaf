import { describe, expect, it } from "vitest";
import { markdownForReaderWithOriginalLines } from "./RichDiffRender";

describe("markdownForReaderWithOriginalLines", () => {
  it("removes YAML frontmatter while preserving original source line numbers", () => {
    const source = [
      "---",
      "id: rendering-fixture",
      "title: Rendering Fixture",
      "---",
      "# Rendering Fixture",
      "",
      "Body.",
    ].join("\n");

    expect(markdownForReaderWithOriginalLines(source)).toBe([
      "",
      "",
      "",
      "",
      "# Rendering Fixture",
      "",
      "Body.",
    ].join("\n"));
  });

  it("leaves ordinary markdown unchanged", () => {
    const source = "# No frontmatter\n\nBody.";
    expect(markdownForReaderWithOriginalLines(source)).toBe(source);
  });
});
