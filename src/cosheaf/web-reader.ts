import {
  hydrateMath,
  hydrateMedia,
  hydrateReaderDisclosures,
  hydrateReaderHoverPreviews,
  hydrateReferences,
  mapDomRangeToSource,
  type ReaderOutlineEntry,
  renderToHtml,
  visibleSourcePositionInScroller,
} from "@chaoxu/coflat/reader";
import { urlPath } from "../../shared/url";
import {
  type CoflatDocumentPayload,
  type CoflatReviewCommentForm,
  type CoflatReviewCommentAnchor,
  loadCoflatDocumentContext,
} from "./coflat-document-context";
import {
  documentRailModel,
} from "../../shared/document-rail";
import { readDocumentTheme, readSectionNumbering } from "./document-theme";
import { renderDocumentRail } from "./document-rail-dom";
import {
  REF_BUTTON_CLASS,
  sanitizeAndRewriteRefsFragment,
} from "./ref-rewriter";
import { markChangedBlocks, markChangeStops, markRichGapContentAnchors, markRichInlineRanges, richDiffBlockForLine } from "./reader-diff-marking";
import { rewritePdfPreviewObjects } from "./pdf-preview-rewrite";

const READER_SCROLL_STATE_KEY = "cosheafReaderScrollTop";
const observedScrollTop = new WeakMap<HTMLElement, number>();

function readPayload(root: HTMLElement): CoflatDocumentPayload | null {
  const script = root.querySelector<HTMLScriptElement>('script[type="application/json"]');
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as CoflatDocumentPayload;
}

async function renderIsland(root: HTMLElement): Promise<void> {
  const payload = readPayload(root);
  if (!payload) return;
  root.dataset.renderDocumentRef = payload.branch;
  root.dataset.renderResourceRef = payload.branchExists === false ? "main" : payload.branch;
  root.dataset.renderResourceFallbackRefs = root.dataset.renderResourceRef === "main" ? "main" : `${root.dataset.renderResourceRef},main`;
  root.dataset.renderPath = payload.path;
  applyDocumentTheme(root);
  const ctx = await loadCoflatDocumentContext(payload);
  const needsSourceAnchors = Boolean(
    payload.markedLines?.length ||
      payload.changeStops?.length ||
      payload.richGapAnchors?.length ||
      payload.richInlineRanges?.length ||
      payload.reviewComments?.length ||
      payload.reviewCommentForm?.lines.length,
  );
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
    layoutGaps: payload.richGapAnchors
      ?.filter((anchor) => anchor.role === "gap")
      .map((anchor) => ({
        id: anchor.id,
        sourceLine: anchor.line,
        placement: anchor.placement,
        className: "rich-gap-spacer",
      })),
    ...(needsSourceAnchors ? { sourceMap: true } : {}),
    ...(payload.sourcePositions || needsSourceAnchors ? { sourcePositions: true } : {}),
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
  const scrollContainer = root.closest<HTMLElement>(".doc-main, .app-content");
  const scrollTopBeforeRender = scrollContainer?.scrollTop ?? 0;
  root.replaceChildren(fragment);
  rewritePdfPreviewObjects(root);
  const latestScrollTop = scrollContainer ? Math.max(scrollTopBeforeRender, observedScrollTop.get(scrollContainer) ?? 0) : 0;
  if (scrollContainer && latestScrollTop > 0) {
    scrollContainer.scrollTop = latestScrollTop;
  }
  hydrateMedia(root);
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
  await hydrateMath(root, { mathMacros: { ...ctx.mathMacros, ...result.mathMacros } });
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
  if (payload.changeStops?.length) {
    markChangeStops(root, payload.changeStops);
  }
  if (payload.richGapAnchors?.length) {
    markRichGapContentAnchors(root, payload.richGapAnchors.filter((anchor) => anchor.role === "content"));
  }
  if (payload.richInlineRanges?.length) {
    markRichInlineRanges(root, payload.richInlineRanges);
  }
  if (payload.reviewCommentForm) {
    placeReviewCommentComposers(root, payload.reviewCommentForm, payload.source);
  }
  if (payload.reviewComments?.length) {
    placeReviewComments(root, payload.reviewComments);
  }
  buildReaderToc(result.outline ?? [], ctx.mathMacros);
  root.dataset.readerHydrated = "1";
  // The browser's native fragment jump fired before this island swapped the
  // rendered document in, so it missed; re-apply it now that the heading exists
  // (#114). Scrolls within .app-content, the only scroll container.
  applyHashScroll(root);
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
  document.addEventListener("scroll", (event) => {
    if (event.target instanceof HTMLElement) {
      observedScrollTop.set(event.target, event.target.scrollTop);
    }
  }, { capture: true, passive: true });

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
  const model = documentRailModel({
    mode: "read",
    readHref: rail.dataset.readHref ?? window.location.href,
    editHref: rail.dataset.editHref || null,
    controls: rail.dataset.documentRailControls !== "none",
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

function documentEditHref(): string | null {
  const href = document.querySelector<HTMLElement>("[data-document-rail]")?.dataset.editHref;
  return href && href.trim() ? href : null;
}

function sourceAnchorEditHref(editHref: string, range: { from: number; to: number }): string {
  const url = new URL(editHref, window.location.href);
  url.searchParams.set("mode", "edit");
  url.searchParams.set("source_from", String(range.from));
  url.searchParams.set("source_to", String(range.to));
  return `${url.pathname}${url.search}${url.hash}`;
}

function currentSourceAnchorEditHref(editHref: string): string | null {
  const container = readerScrollContainer();
  if (!container) return null;
  const position = visibleSourcePositionInScroller(container, { viewportRatio: 0.5 });
  if (!position) return null;
  return sourceAnchorEditHref(editHref, { from: position.pos, to: position.pos });
}

function installReaderModeLinkAnchors(): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLAnchorElement>("a[data-doc-mode-link]");
    if (!anchor) return;
    const editHref = documentEditHref();
    if (!editHref) return;
    const anchorUrl = new URL(anchor.href, window.location.href);
    const editUrl = new URL(editHref, window.location.href);
    if (anchorUrl.pathname !== editUrl.pathname || anchorUrl.searchParams.get("mode") !== "edit") return;
    const anchored = currentSourceAnchorEditHref(editHref);
    if (anchored) anchor.href = anchored;
  }, { capture: true });
}

function placeReviewComments(root: HTMLElement, comments: readonly CoflatReviewCommentAnchor[]): void {
  for (const old of root.querySelectorAll(".rich-review-comment")) old.remove();
  const grouped = new Map<HTMLElement, CoflatReviewCommentAnchor[]>();
  for (const comment of comments) {
    const target = richDiffBlockForLine(root, comment.line);
    if (!target) continue;
    const host = reviewCommentHost(target);
    grouped.set(host, [...(grouped.get(host) ?? []), comment]);
  }
  for (const [target, targetComments] of grouped) {
    const wrap = document.createElement("div");
    wrap.className = "rich-review-comments";
    for (const comment of targetComments) {
      const card = document.createElement("article");
      card.className = "rich-review-comment";
      card.dataset.commentId = String(comment.id);
      card.dataset.commentSide = comment.side;
      card.dataset.commentLine = String(comment.line);
      if (comment.outdated) card.classList.add("outdated");
      const header = document.createElement("div");
      header.className = "rich-review-comment-header";
      const author = document.createElement("strong");
      author.textContent = comment.author;
      const meta = document.createElement("span");
      meta.textContent = comment.outdated ? "outdated" : `${comment.side}:${comment.line}`;
      header.append(author, meta);
      const body = document.createElement("p");
      if (comment.bodyHtml) {
        body.innerHTML = comment.bodyHtml;
      } else {
        body.textContent = comment.body;
      }
      card.append(header, body);
      wrap.append(card);
    }
    target.insertAdjacentElement("afterend", wrap);
  }
}

function placeReviewCommentComposers(root: HTMLElement, form: CoflatReviewCommentForm, source: string): void {
  for (const old of root.querySelectorAll(".rich-line-composer")) old.remove();
  const seenHosts = new Set<HTMLElement>();
  for (const line of form.lines) {
    const target = richDiffBlockForLine(root, line);
    if (!target) continue;
    const host = reviewCommentHost(target);
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    host.classList.add("rich-commentable");
    placeReviewCommentComposer(host, reviewCommentComposer(form, line, `Comment on line ${line}`, host));
  }
  placeBibliographyReviewCommentComposers(root, form, source);
}

function placeReviewCommentComposer(host: HTMLElement, composer: HTMLDetailsElement): void {
  if (host.classList.contains("cf-doc-section-heading-collapsible")) {
    composer.classList.add("rich-line-composer-before");
    host.insertAdjacentElement("beforebegin", composer);
    return;
  }
  host.insertAdjacentElement("afterend", composer);
}

function placeBibliographyReviewCommentComposers(root: HTMLElement, form: CoflatReviewCommentForm, source: string): void {
  const commentable = new Set(form.lines);
  if (commentable.size === 0) return;
  for (const entry of root.querySelectorAll<HTMLElement>(".cf-bibliography-entry")) {
    const key = entry.dataset.citationKey;
    const line = bibliographyEntryCommentLine(entry, source, commentable);
    if (line === null) continue;
    entry.classList.add("rich-commentable");
    entry.insertAdjacentElement(
      "afterend",
      reviewCommentComposer(form, line, key ? `Comment on reference ${key} at line ${line}` : `Comment on reference at line ${line}`, entry),
    );
  }
}

function bibliographyEntryCommentLine(entry: HTMLElement, source: string, commentable: ReadonlySet<number>): number | null {
  const offsets = [...entry.querySelectorAll<HTMLElement>(".cf-bibliography-backlink[data-source-from]")]
    .map((link) => Number(link.dataset.sourceFrom))
    .filter((offset) => Number.isFinite(offset) && offset >= 0)
    .sort((a, b) => a - b);
  for (const offset of offsets) {
    const line = sourceLineForOffset(source, offset);
    if (commentable.has(line)) return line;
  }
  return null;
}

function sourceLineForOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < source.length && i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function reviewCommentComposer(form: CoflatReviewCommentForm, line: number, label: string, host: HTMLElement): HTMLDetailsElement {
  const composer = document.createElement("details");
  composer.className = "line-composer rich-line-composer";
  composer.style.setProperty("--rich-composer-host-height", `${Math.max(22, Math.ceil(host.getBoundingClientRect().height))}px`);
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", label);
  summary.textContent = "+";
  const formEl = document.createElement("form");
  formEl.method = "post";
  formEl.action = form.action;
  for (const [name, value] of [
    ["path", form.path],
    ["side", form.side],
    ["line", String(line)],
    ["mode", form.mode],
    ["shape", form.shape],
  ] as const) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    formEl.append(input);
  }
  const textarea = document.createElement("textarea");
  textarea.name = "body";
  textarea.required = true;
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Comment";
  formEl.append(textarea, button);
  composer.append(summary, formEl);
  return composer;
}

function reviewCommentHost(target: HTMLElement): HTMLElement {
  return target.closest<HTMLElement>(".cf-doc-paragraph, .cf-doc-heading, .cf-doc-list-item, li, .cf-doc-block, .cf-code-block, blockquote, table")
    ?? target;
}

function nodeElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function installReaderSelectionEditAction(): void {
  let button: HTMLButtonElement | null = null;
  let currentHref: string | null = null;

  const ensureButton = (): HTMLButtonElement => {
    if (button) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "reader-selection-action";
    button.textContent = "Edit selection";
    button.hidden = true;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (currentHref) window.location.href = currentHref;
    });
    document.body.append(button);
    return button;
  };

  const hide = () => {
    if (button) button.hidden = true;
    currentHref = null;
  };

  const update = () => {
    const editHref = documentEditHref();
    const selection = window.getSelection();
    if (!editHref || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hide();
      return;
    }
    const range = selection.getRangeAt(0);
    const reader = nodeElement(range.commonAncestorContainer)?.closest<HTMLElement>(".coflat-reader-island");
    if (!reader || reader.closest("[hidden]")) {
      hide();
      return;
    }
    const sourceRange = mapDomRangeToSource(range, reader);
    const rect = range.getBoundingClientRect();
    if (!sourceRange || rect.width === 0 && rect.height === 0) {
      hide();
      return;
    }
    currentHref = sourceAnchorEditHref(editHref, sourceRange);
    const next = ensureButton();
    next.hidden = false;
    const top = Math.max(8, rect.top - next.offsetHeight - 8);
    const left = Math.min(document.documentElement.clientWidth - next.offsetWidth - 8, Math.max(8, rect.left));
    next.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  document.addEventListener("selectionchange", () => window.requestAnimationFrame(update));
  document.addEventListener("pointerdown", (event) => {
    if (button && event.target instanceof Node && button.contains(event.target)) return;
    window.requestAnimationFrame(update);
  }, { capture: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  document.addEventListener("scroll", hide, { capture: true, passive: true });
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

if (typeof document !== "undefined") {
  installReaderHashHistory();
  hydrateIslandsIn(document);
  if (!document.querySelector(".coflat-reader-island")) void renderStandaloneRail();
  installReaderSelectionEditAction();
  installReaderModeLinkAnchors();

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
}
