import { renderToHtml, hydrateMath, type DocumentContext } from "@chaoxu/coflat-editor/reader";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./ref-rewriter";
import { readDocumentTheme } from "./document-theme";

interface ReaderPayload {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

interface LocalRefs {
  crossrefs: Map<string, string>;
  citations: Map<string, string>;
}

interface BlockDefinition {
  title: string;
  numbered: boolean;
  counter?: string;
  headerPosition?: "inline";
  captionPosition?: "below";
  displayHeader?: boolean;
}

interface BlockEntry {
  type: string;
  id?: string;
  title?: string;
  displayTitle: string;
  displayLabel: string;
  number?: number;
  definition: BlockDefinition;
}

interface ParsedBlockAttrs {
  id?: string;
  classes: string[];
  flags: string[];
  keyValues: Record<string, string>;
}

const blockDefinitions: Record<string, BlockDefinition> = {
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

function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function resolveRepoLink(payload: ReaderPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const baseDir = payload.path.includes("/") ? payload.path.slice(0, payload.path.lastIndexOf("/")) : "";
  const normalized = new URL(withoutHash, `https://cosheaf.invalid/${baseDir ? `${baseDir}/` : ""}`).pathname.slice(1);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function resolveRawRepoLink(payload: ReaderPayload, href: string): string | null {
  const resolved = resolveRepoLink(payload, href);
  if (!resolved) return null;
  const prefix = `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/src/branch/`;
  if (!resolved.startsWith(prefix)) return null;
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/raw/branch/${resolved.slice(prefix.length)}`;
}

function documentContext(payload: ReaderPayload, refs: LocalRefs): DocumentContext {
  return {
    linkResolver: {
      resolve: (href) => {
        const resolved = resolveRepoLink(payload, href);
        return resolved ? { href: resolved } : null;
      },
    },
    refResolver: {
      resolve: (key) => {
        const citation = refs.citations.get(key);
        if (citation) return { content: citation, className: "cf-citation" };
        return {
          content: `[@${key}]`,
          className: `${REF_BUTTON_CLASS} cosheaf-ref-page`,
        };
      },
    },
  };
}

function readPayload(root: HTMLElement): ReaderPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as ReaderPayload;
}

async function renderIsland(root: HTMLElement): Promise<void> {
  const payload = readPayload(root);
  if (!payload) return;
  applyDocumentTheme(root);
  const parsed = parseFrontmatterYaml(payload.source);
  const refs = await localRefs(payload, parsed.frontmatter);
  const rendered = renderToHtml(parsed.body, documentContext(payload, refs)).html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  decorateRenderedBlocks(fragment, parsed.body);
  fixLabeledDisplayMath(fragment);
  resolveRenderedCrossrefs(fragment, refs.crossrefs);
  rewriteRenderedRepoUrls(fragment, payload);
  root.replaceChildren(fragment);
  hydrateMath(root);
}

function applyDocumentTheme(root: HTMLElement): void {
  const theme = readDocumentTheme(document.body.dataset.cosheafUser);
  const scope = root.closest(".cf-theme-scope");
  scope?.classList.toggle("cf-theme-blueprint-book", theme === "blueprint-book");
}

async function localRefs(payload: ReaderPayload, frontmatter: Record<string, unknown>): Promise<LocalRefs> {
  return {
    crossrefs: localCrossrefs(payload.source),
    citations: await localCitations(payload, frontmatter),
  };
}

function localCrossrefs(source: string): Map<string, string> {
  const refs = new Map<string, string>();
  let equationNumber = 0;
  for (const match of source.matchAll(/(?:\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])\s*\{#(eq:[^}\s]+)\}/g)) {
    equationNumber += 1;
    refs.set(match[1], `Eq. (${equationNumber})`);
  }

  for (const block of collectBlockEntries(source)) {
    if (!block.id) continue;
    refs.set(block.id, block.displayLabel);
  }
  return refs;
}

function collectBlockEntries(source: string): BlockEntry[] {
  const entries: BlockEntry[] = [];
  const counters = new Map<string, number>();
  for (const line of source.split("\n")) {
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
    });
  }
  return entries;
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

function blockDefinition(type: string, attrs: ParsedBlockAttrs): BlockDefinition {
  const base = blockDefinitions[type] ?? { title: titleCase(type), numbered: true, counter: type };
  return {
    ...base,
    ...(attrs.keyValues.label ? { title: attrs.keyValues.label } : {}),
  };
}

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function blockNumbered(definition: BlockDefinition, attrs: ParsedBlockAttrs): boolean {
  if (attrs.flags.includes("-") || attrs.classes.includes("unnumbered")) return false;
  const numbered = attrs.keyValues.numbered;
  if (numbered === undefined) return definition.numbered;
  return !["false", "0", "no"].includes(numbered.toLowerCase());
}

function decorateRenderedBlocks(root: ParentNode, source: string): void {
  const entries = collectBlockEntries(source);
  let searchFrom = 0;
  for (const block of root.querySelectorAll<HTMLElement>(".cf-doc-block")) {
    if (block.querySelector(":scope > .cf-block-header, :scope > .cf-block-caption")) continue;
    const type = blockTypeFromElement(block);
    if (!type) continue;
    const entryIndex = findBlockEntry(entries, searchFrom, type, block.id || undefined);
    const entry = entryIndex >= 0 ? entries[entryIndex] : null;
    if (!entry) continue;
    searchFrom = entryIndex + 1;
    decorateRenderedBlock(block, entry);
  }
}

function blockTypeFromElement(block: HTMLElement): string | null {
  for (const className of block.classList) {
    if (className.startsWith("cf-doc-block--")) return className.slice("cf-doc-block--".length);
  }
  return null;
}

function findBlockEntry(entries: BlockEntry[], start: number, type: string, id?: string): number {
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== type) continue;
    if (id && entry.id && entry.id !== id) continue;
    return index;
  }
  return -1;
}

function decorateRenderedBlock(block: HTMLElement, entry: BlockEntry): void {
  if (entry.definition.captionPosition === "below") {
    const caption = document.createElement("div");
    caption.className = "cf-block-caption cf-doc-block-caption";
    caption.append(blockHeader(entry));
    if (entry.title) caption.append(document.createTextNode(entry.title));
    block.append(caption);
    return;
  }

  if (entry.definition.headerPosition === "inline") {
    const paragraph = firstChildWithClass(block, "cf-doc-paragraph") ?? prependHeaderParagraph(block);
    paragraph.prepend(blockHeader(entry));
    return;
  }

  const header = document.createElement("p");
  header.className = "cf-doc-paragraph cf-block-header cf-doc-block-header";
  header.append(blockHeader(entry));
  if (entry.title) header.append(blockTitle(entry.title));
  block.prepend(header);
}

function firstChildWithClass(parent: HTMLElement, className: string): HTMLElement | null {
  for (const child of parent.children) {
    if (child instanceof HTMLElement && child.classList.contains(className)) return child;
  }
  return null;
}

function prependHeaderParagraph(block: HTMLElement): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "cf-doc-paragraph";
  block.prepend(paragraph);
  return paragraph;
}

function blockHeader(entry: BlockEntry): HTMLElement {
  const label = document.createElement("span");
  label.className = "cf-block-header-rendered cf-doc-block-label";
  label.textContent = entry.displayLabel;
  return label;
}

function blockTitle(title: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "cf-block-attr-title cf-doc-block-title";
  const open = document.createElement("span");
  open.className = "cf-block-title-paren";
  open.textContent = "(";
  const content = document.createElement("span");
  content.textContent = title;
  const close = document.createElement("span");
  close.className = "cf-block-title-paren";
  close.textContent = ")";
  span.append(open, content, close);
  return span;
}

async function localCitations(payload: ReaderPayload, frontmatter: Record<string, unknown>): Promise<Map<string, string>> {
  const bibliography = typeof frontmatter.bibliography === "string" ? frontmatter.bibliography : null;
  if (!bibliography) return new Map();
  const resolved = resolveRawRepoLink(payload, bibliography);
  if (!resolved) return new Map();
  try {
    const response = await fetch(resolved, { credentials: "same-origin" });
    if (!response.ok) return new Map();
    const keys = bibtexCitationKeys(await response.text());
    return new Map(keys.map((key, index) => [key, `[${index + 1}]`]));
  } catch (_error) {
    return new Map();
  }
}

function bibtexCitationKeys(source: string): string[] {
  return [...source.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1]);
}

function fixLabeledDisplayMath(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>(".cf-doc-display-math[data-math]")) {
    const raw = el.dataset.math ?? "";
    const normalized = displayMathBody(raw);
    if (normalized !== raw) {
      el.dataset.math = normalized;
      el.textContent = normalized;
    }
  }
}

function displayMathBody(raw: string): string {
  const dollars = /^\$\$\s*\n?([\s\S]*?)\n?\$\$(?:\s*\{#[^}]+\})?\s*$/.exec(raw);
  if (dollars) return dollars[1].trim();
  const brackets = /^\\\[\s*\n?([\s\S]*?)\n?\\\](?:\s*\{#[^}]+\})?\s*$/.exec(raw);
  if (brackets) return brackets[1].trim();
  return raw;
}

function resolveRenderedCrossrefs(root: ParentNode, crossrefs: Map<string, string>): void {
  for (const el of root.querySelectorAll<HTMLElement>(".cf-crossref-unresolved[data-ref-key]")) {
    const key = el.dataset.refKey;
    const label = key ? crossrefs.get(key) : null;
    if (!label) continue;
    el.classList.remove("cf-crossref-unresolved");
    el.classList.add("cf-crossref");
    el.textContent = label;
  }
}

function rewriteRenderedRepoUrls(root: ParentNode, payload: ReaderPayload): void {
  for (const el of root.querySelectorAll<HTMLAnchorElement | HTMLImageElement>("a[href], img[src]")) {
    const attr = el instanceof HTMLImageElement ? "src" : "href";
    const value = el.getAttribute(attr);
    if (!value) continue;
    const resolved = el instanceof HTMLImageElement ? resolveRawRepoLink(payload, value) : resolveRepoLink(payload, value);
    if (resolved) el.setAttribute(attr, resolved);
  }
}

function installRefNavigation(): void {
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const ref = target?.closest<HTMLElement>(`.${REF_BUTTON_CLASS}`);
    if (!ref) return;
    const kind = ref.dataset.refKind;
    if (kind === "num" && ref.dataset.refNum) {
      event.preventDefault();
      const match = /^\/([^/]+)\/([^/]+)/.exec(window.location.pathname);
      if (match) window.location.href = `/${match[1]}/${match[2]}/issues/${encodeURIComponent(ref.dataset.refNum)}`;
    }
    if (kind === "path" && ref.dataset.refPath) {
      event.preventDefault();
      const match = /^\/([^/]+)\/([^/]+)/.exec(window.location.pathname);
      if (!match) return;
      const branch = ref.closest<HTMLElement>("[data-reader-branch]")?.dataset.readerBranch ?? "main";
      const line = ref.dataset.refFrom ? `#L${ref.dataset.refFrom}${ref.dataset.refTo && ref.dataset.refTo !== ref.dataset.refFrom ? `-${ref.dataset.refTo}` : ""}` : "";
      window.location.href = `/${match[1]}/${match[2]}/src/branch/${urlPath(branch)}/${urlPath(ref.dataset.refPath)}${line}`;
    }
  });
}

for (const root of document.querySelectorAll<HTMLElement>(".coflat-reader-island")) {
  void renderIsland(root);
}
installRefNavigation();
