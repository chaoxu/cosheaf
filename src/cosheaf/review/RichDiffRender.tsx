// HTML-reader-based Rich diff renderer for the After-only and Split-rendered
// review views. Replaces the previous CodeMirror-based renderers that hosted
// line-tints and inline comment threads as CM6 widgets.
//
// Approach:
//   1. Render the source through @chaoxu/coflat-editor/reader's renderToHtml
//      with `sourceLineAttribution: true`. The reader emits
//      `data-source-line="N"` on every block.
//   2. Mount the HTML directly into a ref so React never re-touches it.
//   3. Walk the rendered DOM and (a) add a tint class to elements whose
//      source-line matches the diff's added/removed lines, (b) mount React
//      CommentThread components into per-line container divs appended after
//      the matching block.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import type { DocumentContext } from "@chaoxu/coflat-editor/reader";
import DOMPurify from "dompurify";
import type { LineComment } from "../api";
import { CommentThread, type CommentActions } from "./CommentThread";
import { groupCommentsByLine } from "./comment-anchors";

interface Props {
  source: string;
  ctx?: DocumentContext;
  addedLines: readonly number[];
  comments: readonly LineComment[];
  side: "new" | "old";
  actions?: CommentActions;
  /** Test id on the outer container, for Playwright. */
  testId?: string;
}

export function RichDiffRender({
  source,
  ctx,
  addedLines,
  comments,
  side,
  actions,
  testId,
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const commentRootsRef = useRef<Map<string, Root>>(new Map());

  const [html, setHtml] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function render(): Promise<void> {
      const { renderToHtml } = await import("@chaoxu/coflat-editor/reader");
      const { html: rendered } = renderToHtml(source, ctx, { sourceLineAttribution: true });
      if (!cancelled) setHtml(DOMPurify.sanitize(rendered));
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [source, ctx]);

  // Mount HTML imperatively so React never re-renders the inner tree.
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    if (root.dataset.cosheafHtml === html) return;
    // Unmount any comment-thread roots we appended into the previous HTML
    // before tearing it down; otherwise React 18+ warns about leaked roots.
    for (const r of commentRootsRef.current.values()) {
      queueMicrotask(() => r.unmount());
    }
    commentRootsRef.current.clear();
    root.innerHTML = html;
    root.dataset.cosheafHtml = html;
    void import("@chaoxu/coflat-editor/reader").then(({ hydrateMath }) => hydrateMath(root));
  }, [html]);

  // Tint added/removed lines.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const set = new Set(addedLines);
    const tintClass = side === "new" ? "cf-diff-added" : "cf-diff-removed";
    for (const el of root.querySelectorAll<HTMLElement>("[data-source-line]")) {
      const line = Number(el.dataset.sourceLine);
      el.classList.toggle(tintClass, set.has(line));
    }
  }, [html, addedLines, side]);

  // Mount comment threads next to anchored blocks.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const byLine = groupCommentsByLine(comments);
    const wanted = new Map<string, LineComment[]>();
    for (const [key, bucket] of byLine) {
      if (key.startsWith(`${side}:`)) wanted.set(key, bucket);
    }
    const roots = commentRootsRef.current;
    // Drop containers we no longer want.
    for (const [key, r] of roots) {
      if (!wanted.has(key)) {
        const host = root.querySelector(`[data-cf-comment-host="${cssEscape(key)}"]`);
        host?.remove();
        queueMicrotask(() => r.unmount());
        roots.delete(key);
      }
    }
    // Create / refresh the containers we do want.
    for (const [key, bucket] of wanted) {
      const lineStr = key.split(":")[1];
      const anchor = root.querySelector<HTMLElement>(`[data-source-line="${lineStr}"]`);
      if (!anchor) continue;
      let host = root.querySelector<HTMLElement>(`[data-cf-comment-host="${cssEscape(key)}"]`);
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-cf-comment-host", key);
        host.setAttribute("data-testid", `comment-thread-${side}-${lineStr}`);
        host.className = "cf-comment-host";
        anchor.insertAdjacentElement("afterend", host);
        const r = createRoot(host);
        roots.set(key, r);
        r.render(createElement(CommentThread, { comments: bucket, ...(actions ?? {}) }));
      } else {
        // Same DOM node still exists; just re-render with new props.
        const r = roots.get(key);
        if (r) r.render(createElement(CommentThread, { comments: bucket, ...(actions ?? {}) }));
      }
    }
  }, [html, comments, side, actions]);

  // Tear down comment-thread React roots on unmount.
  useEffect(
    () => () => {
      for (const r of commentRootsRef.current.values()) {
        queueMicrotask(() => r.unmount());
      }
      commentRootsRef.current.clear();
    },
    [],
  );

  return <div ref={containerRef} data-testid={testId} className="cf-rich-diff prose max-w-none px-4 py-3" />;
}

// Minimal CSS.escape that's safe for our key shape (`new:42`).
function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}
