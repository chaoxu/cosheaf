import { renderToHtml, hydrateMath, hydrateReaderDisclosures, hydrateReaderHoverPreviews, type ReaderOutlineEntry } from "@chaoxu/coflat/reader";
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
  const ctx = coflatDocumentContext(payload, refs);
  // outline:true makes coflat emit stable, collision-free heading ids on the
  // rendered HTML (so deep-link anchors and #114's hash-scroll work without any
  // client-side slugging) and return the outline for the TOC rail (#117).
  // sourceLineAttribution stays opt-in for the PR diff surface (#113).
  const result = renderToHtml(parsed.body, ctx, {
    outline: true,
    ...(payload.markedLines ? { sourceLineAttribution: true } : {}),
  });
  const rendered = result.html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  fixLabeledDisplayMath(fragment);
  resolveRenderedCrossrefs(fragment, refs.crossrefs);
  resolveUnresolvedCoflatReferences(fragment, refs);
  rewriteRenderedRepoUrls(fragment, payload);
  root.replaceChildren(fragment);
  hydrateMath(root);
  // Coflat's hover previews for cross-references, citations, and labeled blocks
  // (theorems/equations). Resolved crossref anchors keep their data-ref-key, so
  // the installer attaches to them; source-based previews use the document source.
  hydrateReaderHoverPreviews(root, { source: payload.source, context: ctx });
  // Section + block (theorem) collapse toggles (#115). Without this the
  // disclosure controls render but never get behavior.
  hydrateReaderDisclosures(root);
  if (payload.markedLines?.length) {
    // The diff's changed-line numbers are raw-file 1-based (they include any
    // YAML frontmatter), but sourceLineAttribution numbers the rendered body —
    // which parseFrontmatterYaml stripped of frontmatter. Shift the marked set
    // by the frontmatter line count so block source-ranges line up (#113).
    const bodyStart = payload.source.length - parsed.body.length;
    const frontmatterLines = bodyStart > 0 ? (payload.source.slice(0, bodyStart).match(/\n/g)?.length ?? 0) : 0;
    markChangedBlocks(root, new Set(payload.markedLines.map((line) => line - frontmatterLines)));
  }
  buildReaderToc(root, result.outline ?? []);
  // The browser's native fragment jump fired before this island swapped the
  // rendered document in, so it missed; re-apply it now that the heading exists
  // (#114). Scrolls within .app-content, the only scroll container.
  applyHashScroll(root);
}

// Highlight rendered blocks whose source-line range intersects the changed
// lines on this side of a PR diff (#113). sourceLineAttribution emits
// data-source-line (single) or data-source-from/-to (a range) on block
// elements; rich rendering is block-structured, so a changed line marks its
// whole containing block.
function markChangedBlocks(root: HTMLElement, marked: ReadonlySet<number>): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-source-line],[data-source-from]")) {
    const from = Number(el.dataset.sourceFrom ?? el.dataset.sourceLine);
    if (!Number.isFinite(from)) continue;
    const to = Number(el.dataset.sourceTo ?? el.dataset.sourceLine ?? el.dataset.sourceFrom);
    const hi = Number.isFinite(to) ? to : from;
    for (let line = from; line <= hi; line++) {
      if (marked.has(line)) {
        el.classList.add("marked");
        break;
      }
    }
  }
}

// Re-scroll to a heading-fragment deep link after the island renders. The
// document is client-rendered, so on initial load the native hash jump fires
// against an empty placeholder; once the real (tall) content is in the DOM we
// land the target ourselves.
function applyHashScroll(root: HTMLElement): void {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const target = root.querySelector(`#${CSS.escape(id)}`);
  if (target instanceof HTMLElement) target.scrollIntoView({ block: "start" });
}

// Fill the file reader's table-of-contents rail from Coflat's outline (#117).
// renderToHtml({outline:true}) emits stable, deduplicated heading ids on the
// rendered HTML and returns these entries, so there is no client-side heading
// scan or slug regex. Only the file-reader page provides a [data-reader-toc]
// slot, so this is a no-op for issue/comment/PR readers.
function buildReaderToc(root: HTMLElement, outline: readonly ReaderOutlineEntry[]): void {
  const slot = root.closest(".doc-with-toc")?.querySelector<HTMLElement>("[data-reader-toc]");
  if (!slot) return;
  const items = outline.filter((entry) => entry.level <= 3);
  if (items.length < 2) return;
  const minLevel = Math.min(...items.map((item) => item.level));
  slot.replaceChildren();
  const title = document.createElement("p");
  title.className = "doc-toc-title";
  title.textContent = "On this page";
  slot.appendChild(title);
  for (const item of items) {
    const link = document.createElement("a");
    link.href = `#${item.id}`;
    link.textContent = item.text;
    link.className = `doc-toc-link lvl-${item.level - minLevel}`;
    slot.appendChild(link);
  }
  slot.hidden = false;
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
  // Repo URLs are always /:owner/:repo/... — the first two path segments are
  // the workspace identity.
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `/${urlPath(parts[0])}/${urlPath(parts[1])}`;
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
