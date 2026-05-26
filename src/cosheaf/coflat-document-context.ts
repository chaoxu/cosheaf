import type { DocumentContext } from "@chaoxu/coflat-editor/reader";
import { extractReferences } from "@chaoxu/coflat-editor/parse";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";

export interface CoflatDocumentPayload {
  source: string;
  owner?: string;
  repo: string;
  branch: string;
  path: string;
}

export interface CoflatLocalRefs {
  crossrefs: Map<string, RenderedCrossref>;
  citations: Map<string, string>;
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

export function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function resolveRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const baseDir = payload.path.includes("/") ? payload.path.slice(0, payload.path.lastIndexOf("/")) : "";
  const normalized = new URL(withoutHash, `https://cosheaf.invalid/${baseDir ? `${baseDir}/` : ""}`).pathname.slice(1);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const resolved = resolveRepoLink(payload, href);
  if (!resolved) return null;
  const prefix = `/${urlPath(payload.repo)}/src/branch/`;
  if (!resolved.startsWith(prefix)) return null;
  return `/${urlPath(payload.repo)}/raw/branch/${resolved.slice(prefix.length)}`;
}

export function coflatDocumentContext(payload: CoflatDocumentPayload, refs: CoflatLocalRefs): DocumentContext {
  return {
    linkResolver: {
      resolve: (href) => {
        const resolved = resolveRepoLink(payload, href);
        return resolved ? { href: resolved } : null;
      },
    },
    refResolver: {
      resolve: (key) => {
        const crossref = refs.crossrefs.get(key);
        if (crossref) {
          return {
            content: escapeHtml(crossref.label),
            href: crossref.href,
            className: "cf-crossref",
          };
        }
        const citation = refs.citations.get(key);
        if (citation) return { content: citation, className: "cf-citation" };
        return null;
      },
    },
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
    const citation = refs.citations.get(key);
    if (citation) rewriteReferenceElement(el, key, citation, "cf-citation");
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
    citations: await localCitations(payload, parsed.frontmatter),
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
    const response = await fetch(`/api/v1/w/${encodeURIComponent(payload.repo)}/refs?ids=${encodeURIComponent(keys.join(","))}`, {
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
        .filter((ref) => (ref.kind === "ref" || ref.kind === "crossref") && ref.key)
        .map((ref) => ref.key as string),
    ),
  ];
}

function refHref(payload: CoflatDocumentPayload, ref: WorkspaceRef): string {
  const fragment = ref.fragment ? `#${encodeURIComponent(ref.fragment)}` : "";
  return `/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(ref.path)}${fragment}`;
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

async function localCitations(payload: CoflatDocumentPayload, frontmatter: Record<string, unknown>): Promise<Map<string, string>> {
  const bibliography = typeof frontmatter.bibliography === "string" ? frontmatter.bibliography : null;
  if (!bibliography) return new Map();
  const rawUrls = [
    resolveRawRepoLink(payload, bibliography),
    payload.branch === "main" ? null : resolveRawRepoLink({ ...payload, branch: "main" }, bibliography),
  ].filter((value): value is string => Boolean(value));
  try {
    for (const url of rawUrls) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) continue;
      const keys = bibtexCitationKeys(await response.text());
      return new Map(keys.map((key, index) => [key, `[${index + 1}]`]));
    }
  } catch (_error) {
    return new Map();
  }
  return new Map();
}

function bibtexCitationKeys(source: string): string[] {
  return [...source.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1]);
}
