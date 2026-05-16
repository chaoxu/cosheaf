// Cosheaf-specific frontmatter helpers. The canonical YAML parser/serializer
// lives in `@chaoxu/coflat-editor/parse` so cosheaf and coflat agree on
// every edge case (and we don't ship a separate YAML dependency).
//
// Cosheaf-only knobs that don't belong in coflat:
//   - `generateDocId()`: cosheaf's 8-char base36 doc id.
//   - `extractTitle()`: pull the first H1 from a body.
//
// `parseDocument` / `serializeDocument` are thin wrappers around coflat's
// `parseFrontmatter` / `serializeFrontmatter` to preserve cosheaf's
// historical return shape (`hadFrontmatter` + body-equals-source on bad
// YAML).

import { randomBytes } from "node:crypto";
import { parseFrontmatter, serializeFrontmatter } from "@chaoxu/coflat-editor/parse";

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

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function parseDocument(content: string): ParsedDocument {
  const r = parseFrontmatter(content);
  if (r.range === null) {
    // No frontmatter block at all.
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  if (r.frontmatter === null) {
    // Malformed YAML inside a well-formed block. Historical cosheaf behavior
    // is to treat this as "no frontmatter present" AND return the body as
    // the unmodified source (so callers see the failure verbatim).
    return { frontmatter: {}, body: content, hadFrontmatter: false };
  }
  return { frontmatter: r.frontmatter as Frontmatter, body: r.body, hadFrontmatter: true };
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const compacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null && v !== "") compacted[k] = v;
  }
  // Coflat synthesizes a leading frontmatter block. Match cosheaf's prior
  // shape: strip any leading newlines from body so we don't double-blank.
  const cleanBody = body.replace(/^\n+/, "");
  return serializeFrontmatter(compacted, cleanBody);
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
