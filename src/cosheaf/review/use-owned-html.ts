import { useLayoutEffect } from "react";
import type { RefObject } from "react";

interface OwnedHtmlOptions {
  beforeReplace?: (root: HTMLElement) => void;
  afterReplace?: (root: HTMLElement) => void;
}

export function useOwnedHtml(
  containerRef: RefObject<HTMLElement | null>,
  html: string,
  options: OwnedHtmlOptions = {},
): void {
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    if (root.dataset.cosheafHtml === html) return;
    options.beforeReplace?.(root);
    root.innerHTML = html;
    root.dataset.cosheafHtml = html;
    options.afterReplace?.(root);
  }, [containerRef, html, options]);
}
