import {
  extractFirstH1,
  parseFrontmatterYaml,
  serializeFrontmatterYaml,
  type Frontmatter,
  type ParsedDocument,
} from "../shared/frontmatter-yaml.js";
import { generateDocId } from "./ids.js";

export type { Frontmatter, ParsedDocument };
export { generateDocId };

export function parseDocument(content: string): ParsedDocument {
  return parseFrontmatterYaml(content);
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  return serializeFrontmatterYaml(frontmatter, body);
}

export function extractTitle(body: string): string | null {
  return extractFirstH1(body);
}
