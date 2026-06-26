import { renderInlineMarkdown } from "@chaoxu/coflat/inline-render";
import { hydrateMath } from "@chaoxu/coflat/reader";
import { sanitizeAndRewriteRefsFragment } from "./ref-rewriter";

export function renderInertChromeInline(
  container: HTMLElement,
  opts: { html?: string; fallback: string; mathMacros?: Record<string, string> },
): void {
  container.replaceChildren();
  if (!opts.html) {
    renderInlineMarkdown(container, opts.fallback, opts.mathMacros ?? {}, "ui-chrome-inline");
    normalizeChromeInline(container);
    return;
  }
  const fragment = sanitizeAndRewriteRefsFragment(opts.html);
  for (const interactive of Array.from(fragment.querySelectorAll("a, button"))) {
    const span = document.createElement("span");
    span.className = interactive.className;
    span.replaceChildren(...Array.from(interactive.childNodes));
    interactive.replaceWith(span);
  }
  container.replaceChildren(fragment);
  hydrateMath(container, { mathMacros: opts.mathMacros ?? {} });
  normalizeChromeInline(container);
}

function normalizeChromeInline(container: HTMLElement): void {
  for (const link of Array.from(container.querySelectorAll(".cf-doc-link, .cf-link-rendered"))) {
    link.replaceWith(document.createTextNode(link.textContent ?? ""));
  }
}
