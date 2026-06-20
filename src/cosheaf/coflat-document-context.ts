import type { CitationFormatter } from "@chaoxu/coflat/citeproc";
import ieeeCslXml from "@chaoxu/coflat/latex/csl/ieee.csl?raw";
import {
  extractReferences,
  parseFrontmatter,
  resolveMarkdownReferencePathFromDocument,
} from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
import { urlPath } from "../../shared/url";

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
  /** Render the frontmatter `title` as a document-title heading, matching the
   * editor's rich-mode title widget. Set only for the document surface (not
   * comments/diffs). */
  renderTitle?: boolean;
  /** Repo-wide KaTeX macros from cosheaf.yaml `math:` (#182/#183), resolved
   * server-side per branch. The document's own frontmatter `math:` overrides
   * these per key when the context is built. */
  mathMacros?: Record<string, string>;
  /** Repo-wide paper defaults from cosheaf.yaml; document frontmatter wins. */
  bibliography?: string;
  csl?: string;
}

export interface CoflatDocumentRefs {
  workspaceCrossrefs: Map<string, RenderedCrossref>;
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

const BUILTIN_CSL_XML = new Map<string, string>([
  ["ieee", ieeeCslXml],
]);

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
  return resolveMarkdownReferencePathFromDocument(payload.path, decodeMarkdownPathHref(href));
}

function decodeMarkdownPathHref(href: string): string {
  try {
    return decodeURI(href);
  } catch (_error) {
    return href;
  }
}

function isLineFragment(hash: string): boolean {
  return /^L\d+(?:-(?:L)?\d+)?$/.test(hash);
}

// The coflat link resolver shared by the full reader context and the link-only
// compose island (#20): turns a relative repo link into a same-origin href, and
// returns null for a non-resolvable link — both surfaces must agree on that null
// contract, so it lives in one place.
export function coflatLinkResolver(payload: CoflatDocumentPayload): DocumentContext["linkResolver"] {
  return {
    resolve: (href) => {
      const resolved = resolveRepoLink(payload, href);
      return resolved ? { href: resolved } : null;
    },
  };
}

// Repo-wide macros (payload.mathMacros) as the base, the document's own
// frontmatter `math:` overriding per key. Coflat applies ctx.mathMacros to every
// math render path, so passing the pre-merged result here makes repo macros work
// on every surface (incl. comments) while a doc can still redefine one (#183).
export function resolveMathMacros(payload: CoflatDocumentPayload): Record<string, string> {
  const docMath = parseFrontmatter(payload.source).frontmatter?.math;
  const doc: Record<string, string> = {};
  if (docMath && typeof docMath === "object" && !Array.isArray(docMath)) {
    for (const [k, v] of Object.entries(docMath as Record<string, unknown>)) {
      if (typeof v === "string") doc[k] = v;
    }
  }
  return { ...(payload.mathMacros ?? {}), ...doc };
}

export function coflatDocumentContext(payload: CoflatDocumentPayload, refs: CoflatDocumentRefs): DocumentContext {
  const citations = refs.citations;
  const mathMacros = resolveMathMacros(payload);
  return {
    linkResolver: coflatLinkResolver(payload),
    fileSystem: {
      listTree: async () => ({ name: "", path: "", isDirectory: true, children: [] }),
      readFile: async () => {
        throw new Error("Reader context does not provide text file reads.");
      },
      writeFile: async () => {
        throw new Error("Reader context is read-only.");
      },
      createFile: async () => {
        throw new Error("Reader context is read-only.");
      },
      exists: async () => false,
      renameFile: async () => {
        throw new Error("Reader context is read-only.");
      },
      createDirectory: async () => {
        throw new Error("Reader context is read-only.");
      },
      deleteFile: async () => {
        throw new Error("Reader context is read-only.");
      },
      writeFileBinary: async () => {
        throw new Error("Reader context is read-only.");
      },
      readFileBinary: async () => {
        throw new Error("Reader context does not provide binary file reads.");
      },
      resolveAssetUrl: (path) => resolveRawRepoLink(payload, path) ?? path,
    },
    refResolver: {
      resolve: (key, _mode, env) => {
        const crossref = refs.workspaceCrossrefs.get(key);
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
    // path the editor surface still uses. Local crossrefs are resolved by
    // Coflat's own catalog; the host resolver only carries cross-file workspace
    // targets that Cosheaf's sidecar index knows about.
    ...(citations ? { citationFormatter: citations.formatter, citationKeys: citations.keys } : {}),
    ...(Object.keys(mathMacros).length ? { mathMacros } : {}),
  };
}

export async function loadCoflatDocumentContext(payload: CoflatDocumentPayload): Promise<DocumentContext> {
  return coflatDocumentContext(payload, await loadCoflatRefs(payload));
}

export async function loadCoflatRefs(payload: CoflatDocumentPayload): Promise<CoflatDocumentRefs> {
  const parsed = parseFrontmatter(payload.source);
  const localKeys = new Set(extractCoflatXrefTargets(payload.source).map((target) => target.id));
  return {
    workspaceCrossrefs: await workspaceCrossrefs(payload, payload.source, localKeys),
    citations: await loadCitations(
      payload,
      parsed.frontmatter ?? {},
      parsed.body,
    ),
  };
}

async function workspaceCrossrefs(payload: CoflatDocumentPayload, source: string, localKeys: ReadonlySet<string>): Promise<Map<string, RenderedCrossref>> {
  const keys = referencedKeys(source).filter((key) => !localKeys.has(key));
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
  const bibliography = typeof frontmatter.bibliography === "string"
    ? frontmatter.bibliography
    : payload.bibliography ?? null;
  if (!bibliography) return null;
  const bibText = await fetchBibliography(payload, bibliography);
  if (bibText === null) return null;
  const csl = typeof frontmatter.csl === "string" ? frontmatter.csl : payload.csl ?? null;
  const cslXml = csl ? BUILTIN_CSL_XML.get(csl) ?? await fetchProjectText(payload, csl) : null;
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
    const formatter = createCslCitationFormatter(await CslProcessor.create(items, cslXml ?? undefined));
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
  return fetchProjectText(payload, bibliography);
}

// Fetch a repo-relative text resource, trying the document's branch then
// falling back to main (the file may only exist on main for a fresh edit branch).
async function fetchProjectText(payload: CoflatDocumentPayload, relPath: string): Promise<string | null> {
  const rawUrls = [
    payload.branchExists === false ? null : resolveRawRepoLink(payload, relPath),
    payload.branch === "main" ? null : resolveRawRepoLink({ ...payload, branch: "main" }, relPath),
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
