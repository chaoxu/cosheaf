import type { Frontmatter, ParsedDocument } from "../../shared/frontmatter-yaml.js";

export type { Frontmatter, ParsedDocument };

export interface DocumentLink {
  kind: "id" | "path";
  ref: string;
  raw: string;
  from: number;
  to: number;
  line?: number;
}

export interface DocumentXrefTarget {
  id: string;
  kind: "block" | "equation" | "heading";
  label: string;
  line: number;
}

export interface DocumentFormat {
  id: string;
  displayName: string;
  extensions: readonly string[];
  parseDocument(content: string): ParsedDocument;
  serializeDocument(frontmatter: Frontmatter, body: string): string;
  extractTitle(body: string): string | null;
  extractLinks(source: string): DocumentLink[];
  extractXrefTargets?(source: string): DocumentXrefTarget[];
}
