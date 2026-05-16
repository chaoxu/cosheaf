import { coflatMarkdownFormat, type Frontmatter, type ParsedDocument } from "./document-format/coflat.js";
import { generateDocId } from "./ids.js";

export type { Frontmatter, ParsedDocument };
export { generateDocId };

export function parseDocument(content: string): ParsedDocument {
  return coflatMarkdownFormat.parseDocument(content);
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  return coflatMarkdownFormat.serializeDocument(frontmatter, body);
}

export function extractTitle(body: string): string | null {
  return coflatMarkdownFormat.extractTitle(body);
}
