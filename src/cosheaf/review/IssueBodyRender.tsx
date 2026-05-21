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
// post-process coflat's *output HTML string* (before injecting into the
// DOM) to swap matching text-content runs into <button> elements with
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
import { escapeAttr, escapeHtml } from "../lib/html-escape";
import { normalizeCoflatReaderDom } from "./coflat-reader-dom";

interface RenderProps {
  text: string;
  workspaceSlug: string;
  formatId: DocumentFormatId;
  onOpenPageById?: (cosheafId: string) => void;
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void;
  onOpenNumber?: (n: number) => void;
  /** Workspace-scoped DocumentContext (shared with the editor surface). */
  ctx?: DocumentContext;
  /**
   * Long issue/PR descriptions should keep Coflat's full reader surface so
   * they stay visually close to the editor rich view. Comments and review
   * diff panes use the compact inline surface.
   */
  surface?: "document" | "inline";
}

const REF_PAGE_CLASS = "cosheaf-ref-page";
const REF_BUTTON_CLASS = "cosheaf-ref-button";

// Bare patterns coflat's reader doesn't tokenize (and which we apply only to
// inter-tag text spans, never to attribute values or tag names).
const BARE_REF_RE =
  /(^|[\s(])([\w./-]+\.md(?:#L\d+(?:-\d+)?|#[\w-]+)?|#\d+)\b/g;

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
        const rewritten = injectPageRefTestIds(rewriteBareRefsInHtml(rendered));
        if (!cancelled) setHtml(DOMPurify.sanitize(rewritten));
        return;
      }
      const { body } = parseFrontmatterYaml(text);
      const rendered = await api.renderForgejoMarkdown(workspaceSlug, body);
      if (!cancelled) setHtml(DOMPurify.sanitize(rendered.html));
    }
    void render().catch(() => {
      if (!cancelled) {
        setHtml(DOMPurify.sanitize(`<pre>${escapeHtml(text)}</pre>`));
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
    normalizeCoflatReaderDom(root);
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
      ? "cf-theme-scope cf-reader cf-doc-surface cf-doc-flow cf-issue-body cf-issue-body-document"
      : "cf-reader cf-reader-inline cf-doc-flow cf-issue-body";
  return <div ref={containerRef} className={className} data-reader-surface={surface} />;
}

// Operate on the HTML string emitted by coflat's reader. We must not touch
// content inside <code>, <pre>, <a>, or <span class="cosheaf-ref-page">. We
// take a conservative approach: split on tags, transform only the text spans
// that are NOT enclosed by any of the skip elements.
function rewriteBareRefsInHtml(html: string): string {
  // Tokenize: alternating tag and text runs. The reader emits well-formed
  // HTML (DOMPurify-sanitized when run in a browser), so a regex split on
  // tag boundaries is safe.
  const skipTags = new Set(["code", "pre", "a"]);
  const skipClasses = ["cf-math", "cosheaf-ref-page"];
  const parts: string[] = [];
  let i = 0;
  // Stack of "skip" frames: each entry is the tag we entered.
  const stack: string[] = [];
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      parts.push(maybeRewrite(html.slice(i), stack.length === 0));
      break;
    }
    if (lt > i) parts.push(maybeRewrite(html.slice(i, lt), stack.length === 0));
    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      parts.push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt, gt + 1);
    parts.push(tag);
    // Update skip stack.
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>$/.exec(tag);
    if (m) {
      const isClose = m[1] === "/";
      const tagName = m[2].toLowerCase();
      const attrs = m[3];
      const isSkippableByTag = skipTags.has(tagName);
      const isSkippableByClass =
        tagName === "span" && skipClasses.some((c) => attrs.includes(c));
      const isSelfClosing = /\/\s*>$/.test(tag) ||
        ["br", "hr", "img", "input", "meta", "link"].includes(tagName);
      if (!isSelfClosing) {
        if (isClose) {
          // Pop the matching open frame if we have one.
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k] === tagName) {
              stack.splice(k, 1);
              break;
            }
          }
        } else if (isSkippableByTag || isSkippableByClass) {
          stack.push(tagName);
        }
      }
    }
    i = gt + 1;
  }
  return parts.join("");
}

function maybeRewrite(textRun: string, allow: boolean): string {
  if (!allow || textRun.length === 0) return textRun;
  // textRun is HTML-escaped already (coflat escapes special chars in text
  // nodes). Our regex matches printable ASCII + dot + slash + dash; none of
  // those are HTML entities, so we can safely string-match without decoding.
  let out = "";
  let cursor = 0;
  BARE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_REF_RE.exec(textRun)) !== null) {
    const lead = m[1];
    const ref = m[2];
    const matchStart = m.index + lead.length;
    if (matchStart > cursor) out += textRun.slice(cursor, matchStart);
    if (ref.startsWith("#")) {
      const num = ref.slice(1);
      out += `<button type="button" class="${REF_BUTTON_CLASS}" data-ref-kind="num" data-ref-num="${num}" data-testid="ref-num-${num}">#${num}</button>`;
    } else {
      const hashIdx = ref.indexOf("#");
      const path = hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
      const frag = hashIdx >= 0 ? ref.slice(hashIdx + 1) : null;
      const lm = frag ? /^L(\d+)(?:-(\d+))?$/.exec(frag) : null;
      let attrs = `data-ref-kind="path" data-ref-path="${escapeAttr(path)}" data-testid="ref-path-${escapeAttr(path)}"`;
      if (lm) {
        const from = lm[1];
        const to = lm[2] ?? from;
        attrs += ` data-ref-from="${from}" data-ref-to="${to}"`;
      } else if (frag) {
        attrs += ` data-ref-fragment="${escapeAttr(frag)}"`;
      }
      out += `<button type="button" class="${REF_BUTTON_CLASS}" ${attrs}>${escapeHtml(ref)}</button>`;
    }
    cursor = m.index + lead.length + ref.length;
  }
  if (cursor < textRun.length) out += textRun.slice(cursor);
  return out;
}

// Add `data-testid="ref-page-<key>"` to coflat-emitted page-ref spans so
// tests can locate them. We do this on the HTML string (not via
// useLayoutEffect) so the attribute is present at first paint and survives
// React re-renders.
function injectPageRefTestIds(html: string): string {
  return html.replace(/<span\b([^>]*)>/g, (match, attrs) => {
    if (!/\bcosheaf-ref-page\b/.test(attrs)) return match;
    const keyM = /\bdata-ref-key="([^"]+)"/.exec(attrs);
    if (!keyM) return match;
    return `<span${attrs} data-testid="ref-page-${escapeAttr(keyM[1])}">`;
  });
}
