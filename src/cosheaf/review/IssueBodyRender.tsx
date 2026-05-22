// Rich rendering for issue bodies and comments.
//
// Coflat's `./reader` (v0.2.0) is the canonical FORMAT.md renderer:
// markdown structure, sanitization, math placeholders. We supply a
// `RefResolver` so `[@page-id]` resolves to a clickable span for the
// host's onOpenPageById callback.
//
// Two cosheaf-specific patterns aren't part of FORMAT.md and live as bare
// text outside `[](...)` wrappers — `#N` (issue ref) and `path.md#L5-12`
// (line-range link). Coflat's reader leaves these as plain text. We
// post-process coflat's sanitized output DOM to swap matching text-content
// runs into <button> elements with
// data attributes. Click handling is done via a container-level click
// listener so React never sees stale handler refs.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { DocumentContext } from "@chaoxu/coflat-editor/reader";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../../shared/document-format";
import { parseFrontmatterYaml } from "../../../shared/frontmatter-yaml";
import { api } from "../api";
import { escapeHtml } from "../lib/html-escape";

interface RenderProps {
  text: string;
  workspaceSlug: string;
  formatId: DocumentFormatId;
  onOpenPageById?: (cosheafId: string) => void;
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void;
  onOpenNumber?: (n: number) => void;
  /** Workspace-scoped DocumentContext (shared with the editor surface). */
  ctx?: DocumentContext;
  surface?: "document" | "inline";
}

const REF_PAGE_CLASS = "cosheaf-ref-page";
const REF_BUTTON_CLASS = "cosheaf-ref-button";

// Bare patterns coflat's reader doesn't tokenize (and which we apply only to
// inter-tag text spans, never to attribute values or tag names).
const BARE_REF_RE =
  /(^|[\s(])(\[@([\w.:-]+)\]|[\w./-]+\.md(?:#L\d+(?:-\d+)?|#[\w-]+)?|#\d+)(?=\b|[\s).,;:!?]|$)/g;

export function IssueBodyRender({
  text,
  workspaceSlug,
  formatId,
  onOpenPageById,
  onOpenPath,
  onOpenNumber,
  ctx,
  surface = "inline",
}: RenderProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlersRef = useRef({ onOpenPageById, onOpenPath, onOpenNumber });
  handlersRef.current = { onOpenPageById, onOpenPath, onOpenNumber };

  // Fall back to a minimal local resolver so the surface still works without
  // a workspace-scoped ctx (unit tests, isolated previews).
  const effectiveCtx: DocumentContext = useMemo(
    () =>
      ctx ?? {
        refResolver: {
          resolve(key: string, _mode: unknown) {
            return {
              content: `[@${escapeHtml(key)}]`,
              className: `${REF_PAGE_CLASS} ${REF_BUTTON_CLASS}`,
            };
          },
        },
      },
    [ctx],
  );

  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    async function render(): Promise<void> {
      if (formatId === COFLAT_FORMAT_ID) {
        const { renderToHtml } = await import("@chaoxu/coflat-editor/reader");
        const { body } = parseFrontmatterYaml(text);
        const { html: rendered } = renderToHtml(body, effectiveCtx);
        if (!cancelled) setHtml(sanitizeAndPrepareCoflatHtml(rendered));
        return;
      }
      const { body } = parseFrontmatterYaml(text);
      const rendered = await api.renderMarkdown(workspaceSlug, body);
      if (!cancelled) setHtml(sanitizeAndPrepareMarkdownHtml(rendered.html));
    }
    void render().catch(() => {
      if (!cancelled) {
        setHtml(sanitizeAndPreparePlainText(text));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [text, workspaceSlug, formatId, effectiveCtx]);

  // Own the DOM directly so React never overwrites our hydrated math.
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    if (root.dataset.cosheafHtml === html) return; // no change, skip
    root.innerHTML = html;
    root.dataset.cosheafHtml = html;
    if (formatId === COFLAT_FORMAT_ID) {
      void import("@chaoxu/coflat-editor/reader").then(({ hydrateMath }) => hydrateMath(root));
    }
  }, [html, formatId]);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest<HTMLElement>(`.${REF_BUTTON_CLASS}`);
      if (!btn) return;
      e.preventDefault();
      const kind = btn.dataset.refKind;
      if (kind === "page") {
        const id = btn.dataset.refKey;
        if (id) handlersRef.current.onOpenPageById?.(id);
      } else if (kind === "num") {
        const n = Number(btn.dataset.refNum);
        if (Number.isFinite(n)) handlersRef.current.onOpenNumber?.(n);
      } else if (kind === "path") {
        const path = btn.dataset.refPath ?? "";
        const fromS = btn.dataset.refFrom;
        const toS = btn.dataset.refTo;
        const fragment = btn.dataset.refFragment ?? null;
        const range =
          fromS && toS ? { from: Number(fromS), to: Number(toS) } : null;
        handlersRef.current.onOpenPath?.(path, range, fragment);
      } else {
        // Page-ref span (cosheaf-ref-page): coflat-emitted, key is in
        // data-ref-key attribute.
        const id = btn.getAttribute("data-ref-key");
        if (id) handlersRef.current.onOpenPageById?.(id);
      }
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  const className =
    surface === "document"
      ? "cf-reader cf-doc-surface cf-doc-flow cf-issue-body"
      : "cf-reader cf-reader-inline cf-doc-flow cf-issue-body";
  return <div ref={containerRef} className={className} data-reader-surface={surface} />;
}

function sanitizeAndPrepareCoflatHtml(rendered: string): string {
  return sanitizeAndPrepareMarkdownHtml(rendered);
}

function sanitizeAndPrepareMarkdownHtml(rendered: string): string {
  const fragment = DOMPurify.sanitize(rendered, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  rewriteBareRefsInFragment(fragment);
  injectPageRefTestIds(fragment);
  const host = document.createElement("div");
  host.append(fragment);
  return host.innerHTML;
}

function sanitizeAndPreparePlainText(text: string): string {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(parseFrontmatterYaml(text).body));
  rewriteBareRefsInFragment(fragment);
  const host = document.createElement("div");
  host.append(fragment);
  return host.innerHTML;
}

function rewriteBareRefsInFragment(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (shouldSkipTextNode(node)) continue;
    const replacement = rewriteBareRefTextNode(node);
    if (replacement) node.replaceWith(replacement);
  }
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  return parent?.closest("code, pre, a, .cf-math, .cosheaf-ref-page") != null;
}

function rewriteBareRefTextNode(node: Text): DocumentFragment | null {
  const textRun = node.data;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let changed = false;
  BARE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_REF_RE.exec(textRun)) !== null) {
    const lead = m[1];
    const ref = m[2];
    const pageKey = m[3];
    const matchStart = m.index + lead.length;
    if (matchStart > cursor) fragment.append(document.createTextNode(textRun.slice(cursor, matchStart)));
    if (pageKey) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${REF_PAGE_CLASS} ${REF_BUTTON_CLASS}`;
      button.dataset.refKind = "page";
      button.dataset.refKey = pageKey;
      button.dataset.testid = `ref-page-${pageKey}`;
      button.textContent = ref;
      fragment.append(button);
    } else if (ref.startsWith("#")) {
      const num = ref.slice(1);
      const button = document.createElement("button");
      button.type = "button";
      button.className = REF_BUTTON_CLASS;
      button.dataset.refKind = "num";
      button.dataset.refNum = num;
      button.dataset.testid = `ref-num-${num}`;
      button.textContent = `#${num}`;
      fragment.append(button);
    } else {
      const hashIdx = ref.indexOf("#");
      const path = hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
      const frag = hashIdx >= 0 ? ref.slice(hashIdx + 1) : null;
      const lm = frag ? /^L(\d+)(?:-(\d+))?$/.exec(frag) : null;
      const button = document.createElement("button");
      button.type = "button";
      button.className = REF_BUTTON_CLASS;
      button.dataset.refKind = "path";
      button.dataset.refPath = path;
      button.dataset.testid = `ref-path-${path}`;
      if (lm) {
        const from = lm[1];
        const to = lm[2] ?? from;
        button.dataset.refFrom = from;
        button.dataset.refTo = to;
      } else if (frag) {
        button.dataset.refFragment = frag;
      }
      button.textContent = ref;
      fragment.append(button);
    }
    cursor = m.index + lead.length + ref.length;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < textRun.length) fragment.append(document.createTextNode(textRun.slice(cursor)));
  return fragment;
}

function injectPageRefTestIds(root: DocumentFragment): void {
  for (const el of root.querySelectorAll<HTMLElement>(`.${REF_PAGE_CLASS}[data-ref-key]`)) {
    const key = el.dataset.refKey;
    if (key) el.dataset.testid = `ref-page-${key}`;
  }
}
