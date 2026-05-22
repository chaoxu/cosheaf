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
import "katex/dist/katex.min.css";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../../shared/document-format";
import { parseFrontmatterYaml } from "../../../shared/frontmatter-yaml";
import { api } from "../api";
import { escapeHtml } from "../lib/html-escape";
import {
  plainTextToRefHtml,
  REF_BUTTON_CLASS,
  REF_PAGE_CLASS,
  sanitizeAndRewriteRefs,
} from "./ref-rewriter";
import { useOwnedHtml } from "./use-owned-html";

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
        if (!cancelled) setHtml(sanitizeAndRewriteRefs(rendered));
        return;
      }
      const { body } = parseFrontmatterYaml(text);
      const rendered = await api.renderMarkdown(workspaceSlug, body);
      if (!cancelled) setHtml(sanitizeAndRewriteRefs(rendered.html));
    }
    void render().catch(() => {
      if (!cancelled) {
        setHtml(plainTextToRefHtml(text));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [text, workspaceSlug, formatId, effectiveCtx]);

  useOwnedHtml(containerRef, html, {
    afterReplace(root) {
      if (formatId === COFLAT_FORMAT_ID) {
        void import("@chaoxu/coflat-editor/reader").then(({ hydrateMath }) => hydrateMath(root));
      }
    },
  });

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
