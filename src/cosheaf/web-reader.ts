import {
  hydrateMath,
  hydrateReaderDisclosures,
  hydrateReaderHoverPreviews,
  hydrateReferences,
  type ReaderOutlineEntry,
  renderToHtml,
  sourceRangeFromDataset,
} from "@chaoxu/coflat/reader";
import { urlPath } from "../../shared/url";
import {
  type CoflatDocumentPayload,
  loadCoflatDocumentContext,
} from "./coflat-document-context";
import {
  type DocumentRailControl,
  documentRailModel,
} from "../../shared/document-rail";
import { readDocumentTheme, readSectionNumbering } from "./document-theme";
import { renderDocumentRail } from "./document-rail-dom";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./ref-rewriter";

const READER_SCROLL_STATE_KEY = "cosheafReaderScrollTop";

function readPayload(root: HTMLElement): CoflatDocumentPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as CoflatDocumentPayload;
}

async function renderIsland(root: HTMLElement): Promise<void> {
  const payload = readPayload(root);
  if (!payload) return;
  applyDocumentTheme(root);
  const ctx = await loadCoflatDocumentContext(payload);
  // outline:true makes coflat emit stable, collision-free heading ids on the
  // rendered HTML (so deep-link anchors and #114's hash-scroll work without any
  // client-side slugging) and return the outline for the TOC rail (#117).
  // sourceLineAttribution stays opt-in for the PR diff surface (#113).
  // resolveReferences makes Coflat's reader resolve in-document crossrefs
  // ([@eq:…]/[@thm:…]/[@sec:…]) and paper citations itself — inline labels, the
  // References list, and hover — from the catalog + citationFormatter on the
  // context. cosheaf only supplies the data; the host refResolver remains a
  // fallback for cross-file workspace refs Coflat can't number (#124, #11/#12).
  const result = renderToHtml(payload.source, ctx, {
    outline: true,
    referencePreviews: true,
    resolveReferences: true,
    sectionNumbering: readSectionNumbering(document.body.dataset.cosheafUser),
    ...(payload.markedLines ? { sourceLineAttribution: true } : {}),
  });
  const rendered = result.html;
  const fragment = sanitizeAndRewriteRefsFragment(rendered);
  // Coflat needs the full source so frontmatter-controlled numbering (e.g.
  // `numbering: global`) and block config are visible to the reader. It also
  // renders the frontmatter title itself; hide that only for non-document
  // surfaces that opted out of title rendering.
  if (!payload.renderTitle) {
    fragment.querySelector(".cf-doc-title")?.remove();
  }
  root.replaceChildren(fragment);
  hydrateReferences(root, ctx, {
    documentPath: payload.path,
    source: payload.source,
    surface: "reader",
  });
  // hydrateMath does NOT read the document — it needs the macros explicitly, or
  // any non-builtin (e.g. \DecRank) renders as "undefined control sequence" red.
  // result.mathMacros covers frontmatter/in-body macros from Coflat's render;
  // ctx.mathMacros also includes Cosheaf's repo-wide cosheaf.yaml macros.
  // Forward both so hydration sees the same macro set as the render pass.
  hydrateMath(root, { mathMacros: { ...ctx.mathMacros, ...result.mathMacros } });
  // Coflat resolves citation/crossref hover natively from the context. The
  // preview index and source are both relative to the full source passed to
  // renderToHtml.
  hydrateReaderHoverPreviews(root, {
    source: payload.source,
    context: ctx,
    referencePreviewIndex: result.referencePreviewIndex,
  });
  // Section + block (theorem) collapse toggles (#115). Without this the
  // disclosure controls render but never get behavior.
  hydrateReaderDisclosures(root);
  if (payload.markedLines?.length) {
    markChangedBlocks(root, new Set(payload.markedLines));
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
    const range =
      sourceRangeFromDataset(el.dataset, "sourceFrom", "sourceTo", { defaultToFrom: true }) ??
      sourceRangeFromDataset(el.dataset, "sourceLine", "sourceLine", { defaultToFrom: true });
    if (!range) continue;
    for (let line = range.from; line <= range.to; line++) {
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

// Fill the file reader's document rail from Coflat's outline (#117).
// renderToHtml({outline:true}) emits stable, deduplicated heading ids on the
// rendered HTML and returns these entries, so there is no client-side heading
// scan or slug regex. Only file-reader pages provide a [data-document-rail]
// mount, so this is a no-op for issue/comment/PR readers.
function buildReaderToc(outline: readonly ReaderOutlineEntry[], mathMacros?: Record<string, string>, mount?: HTMLElement): void {
  const rail = mount ?? document.querySelector<HTMLElement>("[data-document-rail]");
  if (!rail) return;
  const fileControls: DocumentRailControl[] = [];
  if (rail.dataset.pdfHref) fileControls.push({ kind: "link", label: "PDF", href: rail.dataset.pdfHref });
  if (rail.dataset.rawHref) fileControls.push({ kind: "link", label: "Raw", href: rail.dataset.rawHref });
  const model = documentRailModel({
    mode: "read",
    readHref: rail.dataset.readHref ?? window.location.href,
    editHref: rail.dataset.editHref || null,
    fileControls,
    outline: outline.map((entry) => ({
      key: entry.id,
      level: entry.level,
      label: entry.text,
      html: entry.html,
    })),
  });
  renderDocumentRail(rail, {
    ...model,
    mathMacros,
  });
}

async function renderStandaloneRail(): Promise<void> {
  const rail = document.querySelector<HTMLElement>("[data-document-rail]");
  if (!rail) return;
  const payload = readPayload(rail);
  if (!payload) {
    buildReaderToc([], undefined, rail);
    return;
  }
  const ctx = await loadCoflatDocumentContext(payload);
  const result = renderToHtml(payload.source, ctx, {
    outline: true,
    referencePreviews: true,
    resolveReferences: true,
    sectionNumbering: readSectionNumbering(document.body.dataset.cosheafUser),
  });
  buildReaderToc(result.outline ?? [], { ...ctx.mathMacros, ...result.mathMacros }, rail);
}

function applyDocumentTheme(root: HTMLElement): void {
  const theme = readDocumentTheme(document.body.dataset.cosheafUser);
  const scope = root.closest(".cf-theme-scope");
  scope?.classList.toggle("cf-theme-blueprint-book", theme === "blueprint-book");
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
if (!document.querySelector(".coflat-reader-island")) void renderStandaloneRail();

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
