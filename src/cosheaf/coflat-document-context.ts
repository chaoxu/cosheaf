import type { CitationFormatter } from "@chaoxu/coflat/citeproc";
import ieeeCslXml from "@chaoxu/coflat/latex/csl/ieee.csl?raw";
import {
  analyzeReferences,
  extractReferences,
  parseFrontmatter,
  resolveMarkdownReferencePathFromDocument,
} from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { previewAssetPath, type AssetPreviewPaths } from "../../shared/asset-previews";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
import { rawRepoBranchFileHref, repoBranchFileHref } from "../../shared/url";

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
  /** PR diff surface only: first changed source line for each navigable change
   * group. Kept separate from markedLines so visual highlighting can cover the
   * whole change while navigation lands once per group. */
  changeStops?: readonly number[];
  /** PR rich split only: maps rendered source lines to diff-row content or to
   * the neighboring source line where an unmatched gap should be inserted. */
  richGapAnchors?: readonly CoflatRichGapAnchor[];
  /** PR rich diff surface only: absolute source offsets whose rendered text
   * should receive the stronger inline add/delete tint. */
  richInlineRanges?: readonly CoflatRichInlineRange[];
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
  /** Browser-displayable asset previews, e.g. foo.pdf -> foo.png. */
  assetPreviewPaths?: AssetPreviewPaths;
  /** Workbench read/edit switching only: emit source carriers for position mapping. */
  sourcePositions?: boolean;
  /** PR rich-diff surface: review comments anchored to source lines on this side. */
  reviewComments?: readonly CoflatReviewCommentAnchor[];
  /** PR rich-diff surface: form metadata for adding review comments on rendered anchors. */
  reviewCommentForm?: CoflatReviewCommentForm;
}

export interface CoflatReviewCommentAnchor {
  id: number;
  line: number;
  side: "base" | "head";
  author: string;
  body: string;
  bodyHtml?: string;
  outdated?: boolean;
}

export interface CoflatRichGapAnchor {
  id: string;
  line: number;
  role: "content" | "gap";
  placement?: "before" | "after";
}

export interface CoflatRichInlineRange {
  from: number;
  to: number;
  kind: "del" | "add";
}

export interface CoflatReviewCommentForm {
  action: string;
  path: string;
  side: "base" | "head";
  mode: "source" | "rich";
  shape: "unified" | "split" | "after";
  lines: readonly number[];
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
  keys: ReadonlySet<string>;
}

interface CitationCluster {
  readonly ids: readonly string[];
  readonly locators?: readonly (string | undefined)[];
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
  return `${repoBranchFileHref(payload.owner, payload.repo, payload.branch, normalized)}${sourceView}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `${rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoDisplayAssetLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  const assetPath = previewAssetPath(normalized, payload.assetPreviewPaths);
  return `${rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), assetPath)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function resolveRawRepoAssetPath(payload: CoflatDocumentPayload, path: string, purpose: "source" | "display"): string | null {
  const clean = path.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const decodedPath = decodeMarkdownPathHref(withoutHash);
  if (!decodedPath || decodedPath.split("/").includes("..")) return null;
  const assetPath = purpose === "display" ? previewAssetPath(decodedPath, payload.assetPreviewPaths) : decodedPath;
  return `${rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), assetPath)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function rawResourceBranch(payload: CoflatDocumentPayload): string {
  return payload.branchExists === false ? "main" : payload.branch;
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
      resolveAssetUrl: (path, options) => resolveRawRepoAssetPath(payload, path, options?.purpose ?? "display") ?? path,
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
  const workspaceRefs = await workspaceCrossrefs(payload, payload.source, localKeys);
  const citationLocalTargets = new Set([...localKeys, ...workspaceRefs.keys()]);
  return {
    workspaceCrossrefs: workspaceRefs,
    citations: await loadCitations(
      payload,
      parsed.frontmatter ?? {},
      (id) => citationLocalTargets.has(id),
    ),
  };
}

async function workspaceCrossrefs(payload: CoflatDocumentPayload, source: string, localKeys: ReadonlySet<string>): Promise<Map<string, RenderedCrossref>> {
  const keys = referencedKeys(source).filter((key) => !localKeys.has(key));
  if (keys.length === 0) return new Map();
  try {
    const params = new URLSearchParams({ ids: keys.join(",") });
    if (payload.branchExists !== false && payload.branch !== "main") params.set("ref", payload.branch);
    const response = await fetch(`/api/v1/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/refs?${params.toString()}`, {
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

function refHref(payload: CoflatDocumentPayload, ref: WorkspaceRef): string {
  const fragment = ref.fragment ? `#${encodeURIComponent(ref.fragment)}` : "";
  return `${repoBranchFileHref(payload.owner, payload.repo, payload.branch, ref.path)}${fragment}`;
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
  isLocalTarget: (id: string) => boolean,
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
    // Coflat owns BibTeX parsing, citation/crossref precedence, cluster
    // registration order, and CSL formatting. Cosheaf only fetches repo files.
    const { CslProcessor, createCslCitationFormatter, parseBibTeX } = await import("@chaoxu/coflat/citeproc");
    const entries = parseBibTeX(bibText).filter((entry) => !isLocalTarget(entry.id));
    if (entries.length === 0) return null;
    const processor = await CslProcessor.create(entries, cslXml ?? undefined);
    const keys = new Set(entries.map((entry) => entry.id));
    const formatter = createCslCitationFormatter(processor);
    const clusters = citationClusters(payload.source, keys, isLocalTarget);
    formatter.registerCitations(clusters);
    return {
      formatter: fullDocumentCitationFormatter(formatter, clusters),
      keys,
    };
  } catch (_error) {
    // A citeproc/bibliography failure must never break the rest of the render.
    return null;
  }
}

function fullDocumentCitationFormatter(formatter: CitationFormatter, fullClusters: readonly CitationCluster[]): CitationFormatter {
  const fullRegistrationKey = citationRegistrationKey(fullClusters);
  return {
    cite: (ids, locators) => formatter.cite(ids, locators),
    citeNarrative: (id) => formatter.citeNarrative(id),
    bibliographyEntries: (citedIds) => formatter.bibliographyEntries(citedIds),
    registerCitations: (clusters) => {
      const key = citationRegistrationKey(clusters);
      if (key !== fullRegistrationKey || formatter.citationRegistrationKey === fullRegistrationKey) return;
      formatter.registerCitations(clusters);
    },
    get citationRegistrationKey() {
      return fullRegistrationKey;
    },
    get revision() {
      return formatter.revision;
    },
  };
}

function citationRegistrationKey(clusters: readonly CitationCluster[]): string {
  return clusters
    .map((cluster) => cluster.ids.map((id, index) =>
      `${id}\0${cluster.locators?.[index] ?? ""}`).join("\u0001"))
    .join("\u0002");
}

function citationClusters(
  source: string,
  keys: ReadonlySet<string>,
  isLocalTarget: (id: string) => boolean,
): CitationCluster[] {
  const clusters: Array<{ ids: string[]; locators: Array<string | undefined> }> = [];
  for (const ref of analyzeReferences(source).references) {
    const ids: string[] = [];
    const locators: Array<string | undefined> = [];
    ref.ids.forEach((id, index) => {
      if (!keys.has(id) || isLocalTarget(id)) return;
      ids.push(id);
      locators.push(ref.locators[index]);
    });
    if (ids.length > 0) clusters.push({ ids, locators });
  }
  return clusters;
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
