import { describe, expect, it } from "vitest";
import { extractTitle, generateDocId, parseDocument, serializeDocument } from "./frontmatter.js";

describe("frontmatter", () => {
  it("parseDocument handles content without frontmatter", () => {
    const r = parseDocument("# Title\n\nbody");
    expect(r.hadFrontmatter).toBe(false);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Title\n\nbody");
  });

  it("parseDocument extracts a YAML block", () => {
    const r = parseDocument("---\nid: abc12345\ntitle: Hello\n---\n# Hello\n");
    expect(r.hadFrontmatter).toBe(true);
    expect(r.frontmatter.id).toBe("abc12345");
    expect(r.frontmatter.title).toBe("Hello");
    expect(r.body).toBe("# Hello\n");
  });

  it("parseDocument accepts CRLF frontmatter fences", () => {
    const r = parseDocument("---\r\nid: abc12345\r\ntitle: Hello\r\n---\r\n# Hello\r\n");
    expect(r.hadFrontmatter).toBe(true);
    expect(r.frontmatter.id).toBe("abc12345");
    expect(r.frontmatter.title).toBe("Hello");
    expect(r.body).toBe("# Hello\r\n");
  });

  it("parseDocument falls back to no-frontmatter on bad YAML", () => {
    const r = parseDocument("---\n: invalid:\n---\nbody");
    expect(r.hadFrontmatter).toBe(false);
  });

  it("serializeDocument round-trips frontmatter + body", () => {
    const out = serializeDocument({ id: "abc12345", title: "T" }, "# T\n\nbody");
    const r = parseDocument(out);
    expect(r.frontmatter.id).toBe("abc12345");
    expect(r.frontmatter.title).toBe("T");
    expect(r.body).toBe("# T\n\nbody");
  });

  it("serializeDocument drops empty/null/undefined fields", () => {
    const out = serializeDocument({ id: "abc", title: "", desc: null, x: undefined } as Record<string, unknown>, "body");
    expect(out).not.toContain("title:");
    expect(out).not.toContain("desc:");
    expect(out).not.toContain("x:");
    expect(out).toContain("id: abc");
  });

  it("generateDocId returns 8 lowercase alnum chars", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateDocId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it("extractTitle pulls H1 only", () => {
    expect(extractTitle("# Hello\n\nbody")).toBe("Hello");
    expect(extractTitle("## Sub\n\n# Real")).toBe("Real");
    expect(extractTitle("no heading")).toBe(null);
  });

  it("extractTitle ignores fenced code headings", () => {
    expect(extractTitle(["```md", "# Fake", "```", "", "# Real"].join("\n"))).toBe("Real");
  });
});
