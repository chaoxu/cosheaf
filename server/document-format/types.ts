export interface Frontmatter {
  id?: string;
  title?: string;
  type?: string;
  target?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
  hadFrontmatter: boolean;
}

export interface DocumentLink {
  kind: "id" | "path";
  ref: string;
  raw: string;
  from: number;
  to: number;
}

export interface DocumentFormat {
  id: string;
  displayName: string;
  extensions: readonly string[];
  parseDocument(content: string): ParsedDocument;
  serializeDocument(frontmatter: Frontmatter, body: string): string;
  extractTitle(body: string): string | null;
  extractLinks(body: string): DocumentLink[];
}
