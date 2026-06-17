import { describe, expect, it } from "vitest";
import { extractCoflatXrefTargets } from "./coflat-xrefs.js";

describe("extractCoflatXrefTargets", () => {
  it("uses Coflat's frontmatter-aware block numbering", () => {
    const source = [
      "---",
      "numbering: global",
      "---",
      "",
      "::: {.theorem #thm:first}",
      "First.",
      ":::",
      "",
      "::: {.table #tbl:apps}",
      "table",
      ":::",
      "",
      "::: {.proposition #prop:middle}",
      "Middle.",
      ":::",
      "",
      "::: {.theorem #thm:target}",
      "Target.",
      ":::",
    ].join("\n");

    expect(extractCoflatXrefTargets(source).map((target) => [target.kind, target.id, target.label]))
      .toEqual([
        ["block", "thm:first", "Theorem 1"],
        ["block", "tbl:apps", "Table 2"],
        ["block", "prop:middle", "Proposition 3"],
        ["block", "thm:target", "Theorem 4"],
      ]);
  });
});
