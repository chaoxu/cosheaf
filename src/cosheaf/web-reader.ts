import { renderToHtml, hydrateMath, type DocumentContext } from "@chaoxu/coflat-editor/reader";
import { extractReferences } from "@chaoxu/coflat-editor/parse";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
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
  crossrefs: Map<string, RenderedCrossref>;
  citations: Map<string, string>;
}

interface RenderedCrossref {
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
  return `/${urlPath(payload.repo)}/src/branch/${urlPath(payload.branch)}/${urlPath(normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function resolveRawRepoLink(payload: ReaderPayload, href: string): string | null {
  const resolved = resolveRepoLink(payload, href);
  if (!resolved) return null;
  const prefix = `/${urlPath(payload.repo)}/src/branch/`;
  if (!resolved.startsWith(prefix)) return null;
  return `/${urlPath(payload.repo)}/raw/branch/${resolved.slice(prefix.length)}`;
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
  const crossrefs = localCrossrefs(payload.source);
  for (const [key, ref] of await workspaceCrossrefs(payload, payload.source)) {
    if (!crossrefs.has(key)) crossrefs.set(key, ref);
  }
  return {
    crossrefs,
    citations: await localCitations(payload, frontmatter),
  };
}

function localCrossrefs(source: string): Map<string, RenderedCrossref> {
  const refs = new Map<string, RenderedCrossref>();
  for (const target of extractCoflatXrefTargets(source)) {
    refs.set(target.id, { label: target.label, href: `#${encodeURIComponent(target.id)}` });
  }
  return refs;
}

async function workspaceCrossrefs(payload: ReaderPayload, source: string): Promise<Map<string, RenderedCrossref>> {
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

function refHref(payload: ReaderPayload, ref: WorkspaceRef): string {
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

function resolveRenderedCrossrefs(root: ParentNode, crossrefs: Map<string, RenderedCrossref>): void {
  for (const el of root.querySelectorAll<HTMLElement>(".cf-crossref[data-ref-key], .cf-crossref-unresolved[data-ref-key]")) {
    const key = el.dataset.refKey;
    const ref = key ? crossrefs.get(key) : null;
    if (!ref) continue;
    el.classList.remove("cf-crossref-unresolved");
    el.classList.add("cf-crossref");
    if (!ref.href) {
      el.textContent = ref.label;
      continue;
    }
    if (el instanceof HTMLAnchorElement) {
      el.href = ref.href;
      el.textContent = ref.label;
      continue;
    }
    const link = document.createElement("a");
    link.className = el.className;
    link.dataset.refKey = key;
    link.href = ref.href;
    link.textContent = ref.label;
    el.replaceWith(link);
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
    const repoPrefix = currentRepoPrefix();
    if (!repoPrefix) return;
    if (kind === "num" && ref.dataset.refNum) {
      event.preventDefault();
      window.location.href = `${repoPrefix}/issues/${encodeURIComponent(ref.dataset.refNum)}`;
    }
    if (kind === "path" && ref.dataset.refPath) {
      event.preventDefault();
      const branch = ref.closest<HTMLElement>("[data-reader-branch]")?.dataset.readerBranch ?? "main";
      const line = ref.dataset.refFrom ? `#L${ref.dataset.refFrom}${ref.dataset.refTo && ref.dataset.refTo !== ref.dataset.refFrom ? `-${ref.dataset.refTo}` : ""}` : "";
      window.location.href = `${repoPrefix}/src/branch/${urlPath(branch)}/${urlPath(ref.dataset.refPath)}${line}`;
    }
  });
}

function currentRepoPrefix(): string | null {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const repoRoute = new Set(["src", "raw", "_edit", "issues", "pulls", "branches", "activity", "settings", "notifications"]);
  if (parts[1] && repoRoute.has(parts[1])) return `/${urlPath(parts[0])}`;
  if (parts.length >= 2) return `/${urlPath(parts[0])}/${urlPath(parts[1])}`;
  return `/${urlPath(parts[0])}`;
}

for (const root of document.querySelectorAll<HTMLElement>(".coflat-reader-island")) {
  void renderIsland(root);
}
installRefNavigation();
