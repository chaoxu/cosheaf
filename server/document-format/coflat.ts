import { extractReferences } from "@chaoxu/coflat-editor/parse";
import {
  extractFirstH1,
  parseFrontmatterYaml,
  serializeFrontmatterYaml,
} from "../../shared/frontmatter-yaml.js";
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
  return parseFrontmatterYaml(content);
}

function serializeDocument(frontmatter: Frontmatter, body: string): string {
  return serializeFrontmatterYaml(frontmatter, body);
}

function extractTitle(body: string): string | null {
  return extractFirstH1(body);
}

function extractLinks(body: string): DocumentLink[] {
  const out: DocumentLink[] = [];
  for (const ref of extractReferences(body)) {
    if (ref.kind === "crossref" && ref.key) {
      out.push({ kind: "id", ref: ref.key, raw: `[@${ref.key}]`, from: ref.from, to: ref.to });
    } else if (ref.kind === "link" && ref.href) {
      if (!/\.md(?:#[^)\s]+)?$/.test(ref.href)) continue;
      out.push({ kind: "path", ref: ref.href, raw: ref.raw, from: ref.from, to: ref.to });
    }
  }
  return out;
}
