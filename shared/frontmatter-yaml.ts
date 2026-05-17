import { parse, stringify } from "yaml";

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

export function parseFrontmatterYaml(content: string): ParsedDocument {
  const open = /^---\r?\n/.exec(content);
  if (!open && content !== "---") {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  const bodyStart = open ? open[0].length : 3;
  const end = content.indexOf("\n---", bodyStart);
  if (end < 0) return { frontmatter: {}, body: content, hadFrontmatter: false };
  const yamlEnd = content.charCodeAt(end - 1) === 13 ? end - 1 : end;
  const afterFence = end + "\n---".length;
  const nextChar = content[afterFence];
  if (nextChar !== undefined && nextChar !== "\n" && nextChar !== "\r") {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  try {
    const raw = parse(content.slice(bodyStart, yamlEnd));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { frontmatter: {}, body: content.slice(afterFence).replace(/^\r?\n/, ""), hadFrontmatter: true };
    }
    return {
      frontmatter: raw as Frontmatter,
      body: content.slice(afterFence).replace(/^\r?\n/, ""),
      hadFrontmatter: true,
    };
  } catch (_err) {
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
}

export function serializeFrontmatterYaml(frontmatter: Frontmatter, body: string): string {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== null && value !== "") compacted[key] = value;
  }
  const cleanBody = body.replace(/^\n+/, "");
  if (Object.keys(compacted).length === 0) return cleanBody;
  return `---\n${stringify(compacted).trimEnd()}\n---\n${cleanBody}`;
}

export function extractFirstH1(body: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1].trim() : null;
}
