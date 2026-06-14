import type { DocumentContext } from "@chaoxu/coflat/reader";
import type { CitationFormatter } from "@chaoxu/coflat/citeproc";
import { extractReferences } from "@chaoxu/coflat/parse";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
import { urlPath } from "../../shared/url";

// Re-exported for web-reader, which imports urlPath from this module.
export { urlPath };

export interface CoflatDocumentPayload {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** False when the branch has not been created yet (e.g. a fresh edit page);
   * skips raw fetches against the missing branch and goes straight to main. */
  branchExists?: boolean;
  /** PR diff surface only: source line numbers changed on this side. The reader
   * renders with sourceLineAttribution and marks blocks intersecting them (#113). */
  markedLines?: readonly number[];
}

export interface CoflatLocalRefs {
  crossrefs: Map<string, RenderedCrossref>;
  citations: CoflatCitations | null;
}

// Paper-citation state, built from the document's `bibliography` .bib via
// Coflat's own citeproc (single source of truth for BibTeX parsing + CSL
// formatting). `formatter` produces the inline label (IEEE numeric, e.g. [1])
// and the bibliography entries; `keys` is every entry id in the .bib (used to
// tell a citation [@cormen2009] from a workspace crossref [@eq:gaussian]).
// Both are handed to Coflat's reader on the DocumentContext; the reader emits
// the References list itself, so the cited-key order lives only locally as the
// formatter's registration order.
export interface CoflatCitations {
  formatter: CitationFormatter;
  keys: Set<string>;
}

export interface RenderedCrossref {
  label: string;
  href?: string;
}

interface WorkspaceRef {
  id: string;
  path: string;
  kind: "page" | "block" | "equation" | "heading";
  label: string;
  fragment?: string;
  line?: number | null;
}

export function resolveRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  const sourceView = isLineFragment(hash) ? "?view=source" : "";
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${sourceView}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/raw/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function normalizeRepoPath(payload: CoflatDocumentPayload, href: string): string {
  const baseDir = payload.path.includes("/") ? payload.path.slice(0, payload.path.lastIndexOf("/")) : "";
  return new URL(href, `https://cosheaf.invalid/${baseDir ? `${baseDir}/` : ""}`).pathname.slice(1);
}

function isLineFragment(hash: string): boolean {
  return /^L\d+(?:-(?:L)?\d+)?$/.test(hash);
}

export function coflatDocumentContext(payload: CoflatDocumentPayload, refs: CoflatLocalRefs): DocumentContext {
  const citations = refs.citations;
  return {
    linkResolver: {
      resolve: (href) => {
        const resolved = resolveRepoLink(payload, href);
        return resolved ? { href: resolved } : null;
      },
    },
    refResolver: {
      resolve: (key, _mode, env) => {
        const crossref = refs.crossrefs.get(key);
        if (crossref) {
          return {
            content: escapeHtml(crossref.label),
            href: crossref.href,
            className: "cf-crossref",
          };
        }
        if (citations?.keys.has(key)) {
          const locator = env?.locator;
          return { content: citations.formatter.cite([key], [locator]), className: "cf-citation" };
        }
        return null;
      },
    },
    // The reader resolves citations natively from these (inline label, hover,
    // and the References list); the refResolver branch above is the fallback
    // path the editor surface still uses. Crossrefs are resolved by the reader's
    // own catalog (renderToHtml resolveReferences), with refResolver as the
    // fallback for cross-file workspace targets.
    ...(citations ? { citationFormatter: citations.formatter, citationKeys: citations.keys } : {}),
  };
}

export function resolveUnresolvedCoflatReferences(root: ParentNode, refs: CoflatLocalRefs): void {
  for (const el of root.querySelectorAll<HTMLElement>(".cf-crossref-unresolved, .cf-citation-unresolved")) {
    const key = el.dataset.refKey ?? sourceReferenceKey(el.textContent ?? "");
    if (!key) continue;
    const crossref = refs.crossrefs.get(key);
    if (crossref) {
      rewriteReferenceElement(el, key, crossref.label, "cf-crossref", crossref.href);
      continue;
    }
    if (refs.citations?.keys.has(key)) {
      rewriteReferenceElement(el, key, refs.citations.formatter.cite([key], [undefined]), "cf-citation");
    }
  }
}

export async function loadCoflatRefs(payload: CoflatDocumentPayload): Promise<CoflatLocalRefs> {
  const parsed = parseFrontmatterYaml(payload.source);
  const crossrefs = localCrossrefs(payload.source);
  for (const [key, ref] of await workspaceCrossrefs(payload, payload.source)) {
    if (!crossrefs.has(key)) crossrefs.set(key, ref);
  }
  return {
    crossrefs,
    citations: await loadCitations(payload, parsed.frontmatter, parsed.body),
  };
}

function sourceReferenceKey(value: string): string | null {
  const bracketed = /^\s*\[@([^;\]\s]+)\]\s*$/.exec(value);
  if (bracketed) return bracketed[1];
  const narrative = /^\s*@([A-Za-z0-9:._-]+)\s*$/.exec(value);
  return narrative?.[1] ?? null;
}

function rewriteReferenceElement(el: HTMLElement, key: string, text: string, className: string, href?: string): void {
  el.classList.remove("cf-crossref-unresolved", "cf-citation-unresolved");
  el.classList.add(className);
  el.dataset.refKey = key;
  if (!href) {
    el.textContent = text;
    return;
  }
  if (el instanceof HTMLAnchorElement) {
    el.href = href;
    el.textContent = text;
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  el.replaceChildren(link);
}

function localCrossrefs(source: string): Map<string, RenderedCrossref> {
  const refs = new Map<string, RenderedCrossref>();
  for (const target of extractCoflatXrefTargets(source)) {
    refs.set(target.id, { label: target.label, href: `#${encodeURIComponent(target.id)}` });
  }
  return refs;
}

async function workspaceCrossrefs(payload: CoflatDocumentPayload, source: string): Promise<Map<string, RenderedCrossref>> {
  const keys = referencedKeys(source);
  if (keys.length === 0) return new Map();
  try {
    const response = await fetch(`/api/v1/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/refs?ids=${encodeURIComponent(keys.join(","))}`, {
      credentials: "same-origin",
    });
    if (!response.ok) return new Map();
    const body = (await response.json()) as { refs?: WorkspaceRef[] };
    const refs = new Map<string, RenderedCrossref>();
    for (const ref of body.refs ?? []) {
      if (refs.has(ref.id)) continue;
      refs.set(ref.id, {
        label: ref.label,
        href: refHref(payload, ref),
      });
    }
    return refs;
  } catch (_error) {
    return new Map();
  }
}

function referencedKeys(source: string): string[] {
  return [
    ...new Set(
      extractReferences(source)
        .filter((ref) => ref.kind === "crossref" && ref.key)
        .map((ref) => ref.key as string),
    ),
  ];
}

// Citation keys written as bracketed [@key] (not bare narrative @key), in
// first-appearance order — the form the reader resolves to an inline [N], and
// thus the set the References list and citeproc numbering register from.
function bracketedCitationKeys(source: string): string[] {
  return [
    ...new Set(
      extractReferences(source)
        .filter((ref) => ref.kind === "crossref" && ref.key && ref.bracketed === true)
        .map((ref) => ref.key as string),
    ),
  ];
}

function refHref(payload: CoflatDocumentPayload, ref: WorkspaceRef): string {
  const fragment = ref.fragment ? `#${encodeURIComponent(ref.fragment)}` : "";
  return `/${urlPath(payload.owner)}/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(ref.path)}${fragment}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function loadCitations(
  payload: CoflatDocumentPayload,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<CoflatCitations | null> {
  const bibliography = typeof frontmatter.bibliography === "string" ? frontmatter.bibliography : null;
  if (!bibliography) return null;
  const bibText = await fetchBibliography(payload, bibliography);
  if (bibText === null) return null;
  try {
    // Coflat owns BibTeX parsing + CSL formatting (single source of truth); its
    // citeproc bundle (citation-js) loads only for documents with a bibliography.
    const { parseBibTeX, CslProcessor, createCslCitationFormatter } = await import("@chaoxu/coflat/citeproc");
    const items = parseBibTeX(bibText);
    if (items.length === 0) return null;
    const keys = new Set(items.map((item) => item.id));
    // Only bracketed [@key] citations get an inline [N] from the reader, so the
    // References list is built from those — a narrative-only @key would render
    // no inline marker and must not leave a dangling bibliography entry.
    const cited = bracketedCitationKeys(body).filter((key) => keys.has(key));
    if (cited.length === 0) return null;
    const formatter = createCslCitationFormatter(await CslProcessor.create(items));
    // Register cited keys in document order so the IEEE numeric style assigns
    // [1], [2], … in appearance order (matching the rendered References list).
    formatter.registerCitations(cited.map((id) => ({ ids: [id] })));
    return { formatter, keys };
  } catch (_error) {
    // A citeproc/bibliography failure must never break the rest of the render.
    return null;
  }
}

// Fetch the raw .bib text, trying the document's branch then falling back to
// main (the bib may only exist on main for a fresh edit branch).
async function fetchBibliography(payload: CoflatDocumentPayload, bibliography: string): Promise<string | null> {
  const rawUrls = [
    payload.branchExists === false ? null : resolveRawRepoLink(payload, bibliography),
    payload.branch === "main" ? null : resolveRawRepoLink({ ...payload, branch: "main" }, bibliography),
  ].filter((value): value is string => Boolean(value));
  try {
    for (const url of rawUrls) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (response.ok) return await response.text();
    }
  } catch (_error) {
    return null;
  }
  return null;
}
