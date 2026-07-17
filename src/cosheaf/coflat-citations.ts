import type { CitationFormatter } from "@chaoxu/coflat/citeproc";
import ieeeCslXml from "@chaoxu/coflat/latex/csl/ieee.csl?raw";
import { analyzeReferences } from "@chaoxu/coflat/parse";
import type { CoflatDocumentPayload } from "./coflat-document-context";
import { resolveRawRepoLink } from "./coflat-repo-links";

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

const BUILTIN_CSL_XML = new Map<string, string>([
  ["ieee", ieeeCslXml],
]);

export async function loadCitations(
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
      `${id}\0${cluster.locators?.[index] ?? ""}`).join(""))
    .join("");
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
