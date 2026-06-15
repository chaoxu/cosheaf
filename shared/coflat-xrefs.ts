import { parseFrontmatterYaml } from "./frontmatter-yaml.js";

export type CoflatXrefTargetKind = "block" | "equation" | "heading";

export interface CoflatXrefTarget {
  id: string;
  kind: CoflatXrefTargetKind;
  label: string;
  line: number;
}

interface CoflatBlockDefinition {
  title: string;
  numbered: boolean;
  counter?: string;
  headerPosition?: "inline";
  captionPosition?: "below";
  displayHeader?: boolean;
}

interface CoflatBlockEntry {
  type: string;
  id?: string;
  title?: string;
  displayTitle: string;
  displayLabel: string;
  number?: number;
  definition: CoflatBlockDefinition;
  line: number;
}

interface ParsedBlockAttrs {
  id?: string;
  classes: string[];
  flags: string[];
  keyValues: Record<string, string>;
}

const blockDefinitions: Record<string, CoflatBlockDefinition> = {
  theorem: { title: "Theorem", numbered: true, counter: "theorem" },
  lemma: { title: "Lemma", numbered: true, counter: "theorem" },
  corollary: { title: "Corollary", numbered: true, counter: "theorem" },
  proposition: { title: "Proposition", numbered: true, counter: "theorem" },
  conjecture: { title: "Conjecture", numbered: true, counter: "theorem" },
  problem: { title: "Problem", numbered: true, counter: "theorem" },
  definition: { title: "Definition", numbered: true, counter: "definition" },
  algorithm: { title: "Algorithm", numbered: true, counter: "algorithm" },
  figure: { title: "Figure", numbered: true, counter: "figure", captionPosition: "below" },
  table: { title: "Table", numbered: true, counter: "table", captionPosition: "below" },
  proof: { title: "Proof", numbered: false, headerPosition: "inline" },
  remark: { title: "Remark", numbered: false },
  example: { title: "Example", numbered: false },
  note: { title: "Note", numbered: false },
  blockquote: { title: "Blockquote", numbered: false, displayHeader: false },
};

export function extractCoflatXrefTargets(source: string): CoflatXrefTarget[] {
  const body = parseFrontmatterYaml(source).body;
  return [
    ...extractHeadingTargets(body),
    ...extractEquationTargets(body),
    ...collectCoflatBlockEntries(body)
      .filter((block): block is CoflatBlockEntry & { id: string } => Boolean(block.id))
      .map((block) => ({
        id: block.id,
        kind: "block" as const,
        label: block.displayLabel,
        line: block.line,
      })),
  ];
}

// Caller (extractCoflatXrefTargets) already strips frontmatter, so this takes
// the body directly — no second parseFrontmatterYaml pass.
function collectCoflatBlockEntries(body: string): CoflatBlockEntry[] {
  const entries: CoflatBlockEntry[] = [];
  const counters = new Map<string, number>();
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^:{3,}\s*\{([^}]*)\}/.exec(line.trim());
    if (!match) continue;
    const attrs = parseBlockAttrs(match[1]);
    const type = attrs.classes[0]?.toLowerCase();
    if (!type) continue;
    const definition = blockDefinition(type, attrs);
    if (definition.displayHeader === false) continue;
    const numbered = blockNumbered(definition, attrs);
    const counter = attrs.keyValues.counter || definition.counter || type;
    const number = numbered ? (counters.get(counter) ?? 0) + 1 : undefined;
    if (number !== undefined) counters.set(counter, number);
    const displayTitle = attrs.keyValues.label || definition.title;
    entries.push({
      type,
      id: attrs.id,
      title: attrs.keyValues.title,
      displayTitle,
      displayLabel: number !== undefined ? `${displayTitle} ${number}` : displayTitle,
      number,
      definition,
      line: index + 1,
    });
  }
  return entries;
}

function extractEquationTargets(body: string): CoflatXrefTarget[] {
  const targets: CoflatXrefTarget[] = [];
  let equationNumber = 0;
  for (const match of body.matchAll(/(?:\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])\s*\{#(eq:[^}\s]+)\}/g)) {
    equationNumber += 1;
    targets.push({
      id: match[1],
      kind: "equation",
      label: `Eq. (${equationNumber})`,
      line: lineFromOffset(body, match.index ?? 0),
    });
  }
  return targets;
}

function extractHeadingTargets(body: string): CoflatXrefTarget[] {
  const targets: CoflatXrefTarget[] = [];
  const counters = [0, 0, 0, 0, 0, 0];
  for (const [index, line] of body.split("\n").entries()) {
    const match = /^(#{1,6})\s+(.+?)(?:\s+\{([^}]*)\})?\s*$/.exec(line.trim());
    if (!match) continue;
    const level = match[1].length;
    counters[level - 1] += 1;
    for (let i = level; i < counters.length; i += 1) counters[i] = 0;
    if (!match[3]) continue;
    const attrs = parseBlockAttrs(match[3]);
    if (!attrs.id) continue;
    const unnumbered = attrs.flags.includes("-") || attrs.classes.includes("unnumbered");
    const label = unnumbered ? "Section" : `Section ${counters.slice(0, level).filter(Boolean).join(".")}`;
    targets.push({ id: attrs.id, kind: "heading", label, line: index + 1 });
  }
  return targets;
}

function parseBlockAttrs(input: string): ParsedBlockAttrs {
  const attrs: ParsedBlockAttrs = { classes: [], flags: [], keyValues: {} };
  for (const token of attributeTokens(input)) {
    if (token.startsWith("#")) attrs.id = token.slice(1);
    else if (token.startsWith(".")) attrs.classes.push(token.slice(1));
    else if (token === "-") attrs.flags.push(token);
    else {
      const eq = token.indexOf("=");
      if (eq > 0) attrs.keyValues[token.slice(0, eq)] = unquoteAttr(token.slice(eq + 1));
    }
  }
  return attrs;
}

function attributeTokens(input: string): string[] {
  return input.match(/[^\s=]+=(?:"[^"]*"|'[^']*'|[^\s]+)|"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquoteAttr(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function blockDefinition(type: string, attrs: ParsedBlockAttrs): CoflatBlockDefinition {
  const base = blockDefinitions[type] ?? { title: titleCase(type), numbered: true, counter: type };
  return {
    ...base,
    ...(attrs.keyValues.label ? { title: attrs.keyValues.label } : {}),
  };
}

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function blockNumbered(definition: CoflatBlockDefinition, attrs: ParsedBlockAttrs): boolean {
  if (attrs.flags.includes("-") || attrs.classes.includes("unnumbered")) return false;
  const numbered = attrs.keyValues.numbered;
  if (numbered === undefined) return definition.numbered;
  return !["false", "0", "no"].includes(numbered.toLowerCase());
}

// 1-based line number of a char offset — the single source of truth for the
// line-attribution math both xref extraction (here) and backlink indexing
// (server/indexer.ts) rely on, so a future CRLF fix lands once.
export function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
