import { describe, expect, it } from "vitest";
import { coflatMarkdownFormat } from "./coflat.js";

const format = coflatMarkdownFormat;

describe("coflatMarkdownFormat", () => {
  it("parses documents without frontmatter", () => {
    const parsed = format.parseDocument("# Title\n\nBody");

    expect(parsed).toEqual({
      frontmatter: {},
      body: "# Title\n\nBody",
      hadFrontmatter: false,
    });
  });

  it("parses documents with frontmatter", () => {
    const parsed = format.parseDocument("---\nid: abc123\ntitle: Hello\n---\n# Hello\n");

    expect(parsed.frontmatter).toMatchObject({ id: "abc123", title: "Hello" });
    expect(parsed.body).toBe("# Hello\n");
    expect(parsed.hadFrontmatter).toBe(true);
  });

  it("treats malformed frontmatter as ordinary body text", () => {
    const source = "---\n: invalid:\n---\n# Body";
    const parsed = format.parseDocument(source);

    expect(parsed).toEqual({
      frontmatter: {},
      body: source,
      hadFrontmatter: false,
    });
  });

  it("serializes compacted frontmatter", () => {
    const serialized = format.serializeDocument(
      { id: "abc123", title: "", keep: "yes", missing: null, empty: undefined },
      "\n\n# Body\n",
    );

    expect(serialized).toBe("---\nid: abc123\nkeep: yes\n---\n# Body\n");
  });

  it("extracts the first H1 title only", () => {
    expect(format.extractTitle("## Subhead\n\n# Real Title\n\n# Later")).toBe("Real Title");
    expect(format.extractTitle("No H1 here")).toBeNull();
  });

  it("extracts titles through the Coflat parser instead of code-fence text", () => {
    expect(format.extractTitle(["```md", "# Fake Title", "```", "", "# Real Title"].join("\n"))).toBe("Real Title");
  });

  it("extracts bracketed id references and markdown page links", () => {
    const links = format.extractLinks(
      "See [@target] and [plain](page.md) and [section](dir/page.md#frag).\n",
    );

    expect(links).toEqual([
      expect.objectContaining({ kind: "id", ref: "target", raw: "[@target]" }),
      expect.objectContaining({ kind: "path", ref: "page.md", raw: "[plain](page.md)" }),
      expect.objectContaining({ kind: "path", ref: "dir/page.md#frag", raw: "[section](dir/page.md#frag)" }),
    ]);
  });

  it("rejects bare URLs and non-page markdown links", () => {
    const links = format.extractLinks(
      "Visit https://example.com, [site](https://example.com), and [text](notes.txt).\n",
    );

    expect(links).toEqual([]);
  });

  it("uses the coflat parser for refs, so code spans and escaped refs are ignored", () => {
    const links = format.extractLinks(
      "See [@real] but ignore `[@code]`, \\[@escaped\\], and `[link](fake.md)`.\n",
    );

    expect(links).toEqual([expect.objectContaining({ kind: "id", ref: "real", raw: "[@real]" })]);
  });

  it("extracts all bracketed refs from one citation cluster in source order", () => {
    const links = format.extractLinks("See [@first; @second] and [page](target.md).\n");

    expect(links).toEqual([
      expect.objectContaining({ kind: "id", ref: "first", raw: "[@first]" }),
      expect.objectContaining({ kind: "id", ref: "second", raw: "[@second]" }),
      expect.objectContaining({ kind: "path", ref: "target.md", raw: "[page](target.md)" }),
    ]);
  });
});
