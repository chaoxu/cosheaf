import { renderInlineMarkdown } from "@chaoxu/coflat";
import { renderToHtml, hydrateMath, hydrateReaderDisclosures, hydrateReaderHoverPreviews, type ReaderOutlineEntry } from "@chaoxu/coflat/reader";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";
import { urlPath } from "../../shared/url";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./ref-rewriter";
import { readDocumentTheme, readSectionNumbering } from "./document-theme";
import {
  coflatDocumentContext,
  loadCoflatRefs,
  resolveRepoLink,
  resolveRawRepoLink,
  type CoflatDocumentPayload,
} from "./coflat-document-context";

const READER_SCROLL_STATE_KEY = "cosheafReaderScrollTop";

function readPayload(root: HTMLElement): CoflatDocumentPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as CoflatDocumentPayload;
}

function renderChromeInline(container: HTMLElement, text: string, mathMacros?: Record<string, string>): void {
  container.replaceChildren();
  renderInlineMarkdown(container, text, mathMacros ?? {}, "ui-chrome-inline");
}

function renderChromeHtmlInline(container: HTMLElement, html: string | undefined, fallback: string, mathMacros?: Record<string, string>): void {
  if (!html) {
    renderChromeInline(container, fallback, mathMacros);
    return;
  }
  const fragment = sanitizeAndRewriteRefsFragment(html);
  for (const interactive of Array.from(fragment.querySelectorAll("a, button"))) {
    const span = document.createElement("span");
    span.className = interactive.className;
    span.replaceChildren(...Array.from(interactive.childNodes));
    interactive.replaceWith(span);
  }
  container.replaceChildren(fragment);
  hydrateMath(container, { mathMacros: mathMacros ?? {} });
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
  // resolveReferences makes Coflat's reader resolve in-document crossrefs
  // ([@eq:…]/[@thm:…]/[@sec:…]) and paper citations itself — inline labels, the
  // References list, and hover — from the catalog + citationFormatter on the
  // context. cosheaf only supplies the data; the host refResolver remains a
  // fallback for cross-file workspace refs Coflat can't number (#124, #11/#12).
  const result = renderToHtml(parsed.body, ctx, {
    outline: true,
    referencePreviews: true,
    resolveReferences: true,
    sectionNumbering: readSectionNumbering(document.body.dataset.cosheafUser),
    ...(payload.markedLines ? { sourceLineAttribution: true } : {}),
  });
  const rendered = result.html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  fixLabeledDisplayMath(fragment);
  rewriteRenderedRepoUrls(fragment, payload);
  // Match the editor's rich mode, which draws the frontmatter `title` as a
  // `.cf-doc-title` widget — the reader otherwise drops it (renderToHtml has no
  // title concept). Document surface only; plain textContent (DOMPurify-safe).
  const title = payload.renderTitle ? parsed.frontmatter.title : undefined;
  if (typeof title === "string" && title.trim()) {
    const titleEl = document.createElement("div");
    titleEl.className = "cf-doc-title";
    renderChromeInline(titleEl, title, ctx.mathMacros);
    fragment.insertBefore(titleEl, fragment.firstChild);
  }
  root.replaceChildren(fragment);
  // hydrateMath does NOT read the document — it needs the macros explicitly, or
  // any non-builtin (e.g. \DecRank) renders as "undefined control sequence" red.
  // renderToHtml only resolves frontmatter `math:` from the full source, but we
  // hand it the frontmatter-stripped body (the diff line-offset logic relies on
  // that), so result.mathMacros is empty. Forward cosheaf's own merged macro set
  // instead — repo-wide cosheaf.yaml ∪ this doc's frontmatter `math:`, the same
  // set already on ctx.mathMacros — with result.mathMacros layered on for any
  // in-body definitions. \R only worked before because it is a KaTeX builtin,
  // which masked this missing wire for both the repo-wide and frontmatter paths.
  hydrateMath(root, { mathMacros: { ...ctx.mathMacros, ...result.mathMacros } });
  // Coflat resolves citation/crossref hover natively from the context. The
  // preview index and source are both relative to the frontmatter-stripped body
  // passed to renderToHtml.
  hydrateReaderHoverPreviews(root, {
    source: parsed.body,
    context: ctx,
    referencePreviewIndex: result.referencePreviewIndex,
  });
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
  buildReaderToc(result.outline ?? [], ctx.mathMacros);
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
  const target = root.querySelector(`#${CSS.escape(id)}`) ?? document.getElementById(id);
  if (target instanceof HTMLElement) target.scrollIntoView({ block: "start" });
}

function readerScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-content");
}

function replaceCurrentHistoryScrollState(scrollTop: number): void {
  const existing = history.state;
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  history.replaceState({ ...base, [READER_SCROLL_STATE_KEY]: scrollTop }, "", window.location.href);
}

function rememberCurrentReaderScrollPosition(): void {
  const container = readerScrollContainer();
  if (!container) return;
  replaceCurrentHistoryScrollState(container.scrollTop);
}

function restoreReaderScrollPosition(state: unknown): boolean {
  const scrollTop = state && typeof state === "object"
    ? (state as Record<string, unknown>)[READER_SCROLL_STATE_KEY]
    : undefined;
  if (typeof scrollTop !== "number" || !Number.isFinite(scrollTop)) return false;
  const container = readerScrollContainer();
  if (!container) return false;
  requestAnimationFrame(() => {
    container.scrollTo({ top: Math.max(0, scrollTop), left: 0, behavior: "auto" });
  });
  return true;
}

function isSameDocumentHashHref(href: string): boolean {
  if (!href) return false;
  const url = new URL(href, window.location.href);
  return (
    url.origin === window.location.origin &&
    url.pathname === window.location.pathname &&
    url.search === window.location.search &&
    url.hash.length > 1
  );
}

function installReaderHashHistory(): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href || !isSameDocumentHashHref(href)) return;
    rememberCurrentReaderScrollPosition();
  }, { capture: true });

  window.addEventListener("popstate", (event) => {
    if (restoreReaderScrollPosition(event.state)) return;
    requestAnimationFrame(() => applyHashScroll(document.body));
  });
}

// Fill the file reader's table-of-contents rail from Coflat's outline (#117).
// renderToHtml({outline:true}) emits stable, deduplicated heading ids on the
// rendered HTML and returns these entries, so there is no client-side heading
// scan or slug regex. Only the file-reader page provides a [data-reader-toc]
// slot, so this is a no-op for issue/comment/PR readers.
function buildReaderToc(outline: readonly ReaderOutlineEntry[], mathMacros?: Record<string, string>): void {
  // Find the TOC fill slot by its stable attribute regardless of region (#120),
  // not via the .doc-with-toc grid — so the TOC could live in the rail or the
  // sidebar. File pages render exactly one slot and one reader island.
  const slot = document.querySelector<HTMLElement>("[data-reader-toc]");
  if (!slot) return;
  const items = outline.filter((entry) => entry.level <= 3);
  // Render the rail whenever the document has at least one h1–h3 heading.
  // The previous >=2 threshold hid the outline for simple/few-heading docs
  // (#125); a single-heading doc still gets a usable "On this page" entry.
  if (items.length < 1) return;
  const minLevel = Math.min(...items.map((item) => item.level));
  slot.replaceChildren();
  const title = document.createElement("p");
  title.className = "doc-toc-title";
  title.textContent = "On this page";
  slot.appendChild(title);
  for (const item of items) {
    const link = document.createElement("a");
    link.href = `#${item.id}`;
    link.className = `doc-toc-link lvl-${item.level - minLevel}`;
    renderChromeHtmlInline(link, item.html, item.text, mathMacros);
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
installReaderHashHistory();
