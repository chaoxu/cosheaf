import YAML from "yaml";
import { randomBytes } from "node:crypto";

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

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function parseDocument(content: string): ParsedDocument {
  const match = FRONTMATTER_FENCE.exec(content);
  if (!match) return { frontmatter: {}, body: content, hadFrontmatter: false };
  let frontmatter: Frontmatter = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object") frontmatter = parsed as Frontmatter;
  } catch (_err) {
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

export function generateDocId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    out += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
  }
  return out;
}

export function extractTitle(body: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1].trim() : null;
}
