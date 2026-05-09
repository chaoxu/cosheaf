import YAML from "yaml";

export interface Frontmatter {
  id?: string;
  title?: string;
  type?: string;
  status?: string;
  target?: string;
  [key: string]: unknown;
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
  hadFrontmatter: boolean;
}

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDocument(content: string): ParsedDocument {
  const match = FRONTMATTER_FENCE.exec(content);
  if (!match) return { frontmatter: {}, body: content, hadFrontmatter: false };
  let frontmatter: Frontmatter = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object") frontmatter = parsed as Frontmatter;
  } catch {
    // Malformed frontmatter is treated as no frontmatter.
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  return { frontmatter, body: content.slice(match[0].length), hadFrontmatter: true };
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const compacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null && v !== "") compacted[k] = v;
  }
  const yaml = YAML.stringify(compacted).trimEnd();
  const cleanBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n${cleanBody}`;
}
