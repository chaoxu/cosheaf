import { extractReferences, parseFrontmatter, serializeFrontmatter } from "@chaoxu/coflat-editor/parse";
import type { DocumentFormat, DocumentLink, Frontmatter, ParsedDocument } from "./types.js";

export type { DocumentFormat, DocumentLink, Frontmatter, ParsedDocument };

export const coflatMarkdownFormat: DocumentFormat = {
  id: "coflat",
  displayName: "Coflat Markdown",
  extensions: [".md"],
  parseDocument,
  serializeDocument,
  extractTitle,
  extractLinks,
};

function parseDocument(content: string): ParsedDocument {
  const r = parseFrontmatter(content);
  if (r.range === null) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  if (r.frontmatter === null) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  return { frontmatter: r.frontmatter as Frontmatter, body: r.body, hadFrontmatter: true };
}

function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const compacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null && v !== "") compacted[k] = v;
  }
  const cleanBody = body.replace(/^\n+/, "");
  return serializeFrontmatter(compacted, cleanBody);
}

function extractTitle(body: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1].trim() : null;
}

function extractLinks(body: string): DocumentLink[] {
  const out: DocumentLink[] = [];
  for (const ref of extractReferences(body)) {
    if (ref.kind === "ref" && ref.mode === "bracketed" && ref.key) {
      out.push({ kind: "id", ref: ref.key, raw: `[@${ref.key}]`, from: ref.from, to: ref.to });
    } else if (ref.kind === "link" && ref.href) {
      if (!/\.md(?:#[^)\s]+)?$/.test(ref.href)) continue;
      out.push({ kind: "path", ref: ref.href, raw: ref.raw, from: ref.from, to: ref.to });
    }
  }
  return out;
}
