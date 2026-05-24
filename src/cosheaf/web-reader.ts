import { renderToHtml, hydrateMath, type DocumentContext } from "@chaoxu/coflat-editor/reader";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./review/ref-rewriter";
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

  const blockCounters = new Map<string, number>();
  for (const line of source.split("\n")) {
    const match = /^:{3,}\s*\{([^}]*)\}/.exec(line.trim());
    if (!match) continue;
    const id = /(?:^|\s)#([^\s}]+)/.exec(match[1])?.[1];
    const type = /(?:^|\s)\.([^\s}]+)/.exec(match[1])?.[1];
    if (!id || !type) continue;
    const label = blockTypeLabel(type);
    if (!label) continue;
    const next = (blockCounters.get(label) ?? 0) + 1;
    blockCounters.set(label, next);
    refs.set(id, `${label} ${next}`);
  }
  return refs;
}

function blockTypeLabel(type: string): string | null {
  switch (type) {
    case "theorem":
      return "Theorem";
    case "proposition":
      return "Proposition";
    case "lemma":
      return "Lemma";
    case "corollary":
      return "Corollary";
    case "conjecture":
      return "Conjecture";
    case "definition":
      return "Definition";
    case "figure":
      return "Figure";
    case "table":
      return "Table";
    default:
      return null;
  }
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
