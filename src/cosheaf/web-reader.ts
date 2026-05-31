import { renderToHtml, hydrateMath } from "@chaoxu/coflat-editor/reader";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./ref-rewriter";
import { readDocumentTheme } from "./document-theme";
import {
  coflatDocumentContext,
  loadCoflatRefs,
  resolveRepoLink,
  resolveRawRepoLink,
  resolveUnresolvedCoflatReferences,
  type CoflatDocumentPayload,
  type RenderedCrossref,
  urlPath,
} from "./coflat-document-context";

function readPayload(root: HTMLElement): CoflatDocumentPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as CoflatDocumentPayload;
}

async function renderIsland(root: HTMLElement): Promise<void> {
  const payload = readPayload(root);
  if (!payload) return;
  applyDocumentTheme(root);
  const parsed = parseFrontmatterYaml(payload.source);
  const refs = await loadCoflatRefs(payload);
  const rendered = renderToHtml(parsed.body, coflatDocumentContext(payload, refs)).html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  fixLabeledDisplayMath(fragment);
  resolveRenderedCrossrefs(fragment, refs.crossrefs);
  resolveUnresolvedCoflatReferences(fragment, refs);
  rewriteRenderedRepoUrls(fragment, payload);
  root.replaceChildren(fragment);
  hydrateMath(root);
}

function applyDocumentTheme(root: HTMLElement): void {
  const theme = readDocumentTheme(document.body.dataset.cosheafUser);
  const scope = root.closest(".cf-theme-scope");
  scope?.classList.toggle("cf-theme-blueprint-book", theme === "blueprint-book");
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

function rewriteRenderedRepoUrls(root: ParentNode, payload: CoflatDocumentPayload): void {
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

function hydrateIslandsIn(scope: ParentNode): void {
  for (const root of scope.querySelectorAll<HTMLElement>(".coflat-reader-island")) void renderIsland(root);
}

hydrateIslandsIn(document);

// Islands inserted after initial load — e.g. the chat thread swapping in new
// turns on a live update — must hydrate too, so watch for them rather than
// scanning only once. renderIsland is a no-op on an already-hydrated island
// (its JSON payload script is gone), so re-notification is harmless.
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches(".coflat-reader-island")) void renderIsland(node);
      hydrateIslandsIn(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

installRefNavigation();
