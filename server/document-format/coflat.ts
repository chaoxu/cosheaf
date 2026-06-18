import {
  buildReferenceCatalog,
  extractFirstH1,
  extractReferences,
  parseFrontmatter as parseCoflatFrontmatter,
  serializeFrontmatter as serializeCoflatFrontmatter,
} from "@chaoxu/coflat/parse";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import type { DocumentFormat, DocumentLink, Frontmatter, ParsedDocument } from "./types.js";

export type { DocumentFormat, DocumentLink, Frontmatter, ParsedDocument };

export const coflatMarkdownFormat: DocumentFormat = {
  id: COFLAT_FORMAT_ID,
  displayName: "Coflat Markdown",
  extensions: [".md"],
  parseDocument,
  serializeDocument,
  extractTitle,
  extractLinks,
  extractXrefTargets: extractCoflatXrefTargets,
};

function parseDocument(content: string): ParsedDocument {
  const parsed = parseCoflatFrontmatter(content);
  if (parsed.frontmatter === null) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  return {
    frontmatter: parsed.frontmatter as Frontmatter,
    body: parsed.body,
    hadFrontmatter: parsed.range !== null,
  };
}

function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== null && value !== "") compacted[key] = value;
  }
  if (Object.keys(compacted).length === 0) return trimLeadingLineFeeds(body);
  return serializeCoflatFrontmatter(compacted, trimLeadingLineFeeds(body));
}

function extractTitle(body: string): string | null {
  return extractFirstH1(body);
}

function trimLeadingLineFeeds(body: string): string {
  let pos = 0;
  while (body[pos] === "\n") pos++;
  return pos === 0 ? body : body.slice(pos);
}

function extractLinks(source: string): DocumentLink[] {
  const out: DocumentLink[] = [];
  for (const ref of buildReferenceCatalog(source).references) {
    if (!ref.bracketed) continue;
    for (const id of ref.ids) {
      out.push({ kind: "id", ref: id, raw: `[@${id}]`, from: ref.from, to: ref.to, line: ref.line });
    }
  }
  for (const ref of extractReferences(source)) {
    if (ref.kind === "crossref" && ref.bracketed && ref.key) {
      continue;
    } else if (ref.kind === "link" && ref.href) {
      if (!isMarkdownPageHref(ref.href)) continue;
      out.push({ kind: "path", ref: ref.href, raw: ref.raw, from: ref.from, to: ref.to });
    }
  }
  return out;
}

function isMarkdownPageHref(href: string): boolean {
  const hash = href.indexOf("#");
  const path = hash < 0 ? href : href.slice(0, hash);
  return path.toLowerCase().endsWith(".md");
}
