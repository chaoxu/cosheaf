import {
  analyzeReferences,
  parseFrontmatter,
} from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { type AssetPreviewPaths } from "../../shared/asset-previews";
import { extractCoflatXrefTargets, referencedCrossrefKeys } from "../../shared/coflat-xrefs";
import { repoBranchFileHref } from "../../shared/url";
import { type CoflatCitations, loadCitations } from "./coflat-citations";
import { coflatLinkResolver, resolveRawRepoAssetPath } from "./coflat-repo-links";
import { readonlyFileSystemBase } from "./coflat-readonly-filesystem";
import { localAnnotationIdFromRef, localAnnotationReference } from "./local-annotation-refs";

export interface CoflatDocumentPayload {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** False when the branch has not been created yet (e.g. a fresh edit page);
   * skips raw fetches against the missing branch and goes straight to main. */
  branchExists?: boolean;
  /** True for a logged-out visitor reading a public repo. The crossref endpoint
   * (/api/v1/.../refs) is auth-gated, so the reader skips it rather than 401. */
  anonymous?: boolean;
  /** Cross-file `[@id]` refs the server pre-resolved from the sidecar (main
   * document reader only). When present the reader renders resolved crossrefs
   * without calling /refs, so logged-out reads resolve them too. */
  crossrefs?: WorkspaceRef[];
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

export function coflatDocumentContextSignature(payload: CoflatDocumentPayload): string {
  const frontmatter = parseFrontmatter(payload.source).frontmatter ?? {};
  const localTargets = extractCoflatXrefTargets(payload.source)
    .map((target) => [target.id, target.kind, target.label, target.line ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  const referenceKeys = referencedCrossrefKeys(payload.source).sort();
  const citationReferences = analyzeReferences(payload.source).references.map((ref) =>
    ref.ids.map((id, index) => [id, ref.locators[index] ?? ""]),
  );
  return JSON.stringify({
    owner: payload.owner,
    repo: payload.repo,
    branch: payload.branch,
    branchExists: payload.branchExists !== false,
    path: payload.path,
    bibliography: optionalFrontmatterString(frontmatter.bibliography) ?? payload.bibliography ?? "",
    csl: optionalFrontmatterString(frontmatter.csl) ?? payload.csl ?? "",
    mathMacros: Object.entries(resolveMathMacros(payload)).sort(([a], [b]) => a.localeCompare(b)),
    assetPreviewPaths: Object.entries(payload.assetPreviewPaths ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    localTargets,
    referenceKeys,
    citationReferences,
  });
}

function optionalFrontmatterString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function coflatDocumentContext(payload: CoflatDocumentPayload, refs: CoflatDocumentRefs): DocumentContext {
  const citations = refs.citations;
  const mathMacros = resolveMathMacros(payload);
  return {
    linkResolver: coflatLinkResolver(payload),
    fileSystem: readonlyFileSystemBase({
      readFile: async () => {
        throw new Error("Reader context does not provide text file reads.");
      },
      readFileBinary: async () => {
        throw new Error("Reader context does not provide binary file reads.");
      },
      resolveAssetUrl: (path, options) => resolveRawRepoAssetPath(payload, path, options?.purpose ?? "display") ?? path,
    }),
    refResolver: {
      resolve: (key, _mode, env) => {
        const localAnnotation = localAnnotationReference(key);
        if (localAnnotation) {
          return {
            content: escapeHtml(localAnnotation.content),
            className: localAnnotation.className,
            onClick: localAnnotation.onClick,
          };
        }
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
  const citationLocalTargets = new Set([
    ...localKeys,
    ...workspaceRefs.keys(),
    ...referencedCrossrefKeys(payload.source).filter((key) => localAnnotationIdFromRef(key)),
  ]);
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
  const keys = referencedCrossrefKeys(source).filter((key) => !localKeys.has(key) && !localAnnotationIdFromRef(key));
  if (keys.length === 0) return new Map();
  // Prefer crossrefs the server pre-resolved from the sidecar and embedded in
  // the payload (present for the main document reader): resolve with no network
  // round-trip, and — crucially — resolve for logged-out public reads, which
  // can't call the auth-gated /refs endpoint.
  if (payload.crossrefs) return crossrefMap(payload, payload.crossrefs, keys);
  // No embed (a branch view): /refs is auth-gated, so a logged-out visitor would
  // only get a 401 (logged as a failed resource). Skip it and render bare refs;
  // a signed-in reader fetches. Citation sources still come from the /raw route.
  if (payload.anonymous) return new Map();
  try {
    const params = new URLSearchParams({ ids: keys.join(",") });
    if (payload.branchExists !== false && payload.branch !== "main") params.set("ref", payload.branch);
    const response = await fetch(`/api/v1/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/refs?${params.toString()}`, {
      credentials: "same-origin",
    });
    if (!response.ok) return new Map();
    const body = (await response.json()) as { refs?: WorkspaceRef[] };
    return crossrefMap(payload, body.refs ?? [], keys);
  } catch (_error) {
    return new Map();
  }
}

// Build the id → rendered-crossref map from a list of resolved refs, keeping only
// the requested (non-local) keys. Shared by the embedded and fetched paths so
// both render identically; the server embeds every referenced key, so the
// `wanted` filter drops same-file ids the reader resolves locally.
function crossrefMap(payload: CoflatDocumentPayload, list: readonly WorkspaceRef[], keys: readonly string[]): Map<string, RenderedCrossref> {
  const wanted = new Set(keys);
  const refs = new Map<string, RenderedCrossref>();
  for (const ref of list) {
    if (!wanted.has(ref.id) || refs.has(ref.id)) continue;
    refs.set(ref.id, { label: ref.label, href: refHref(payload, ref) });
  }
  return refs;
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

