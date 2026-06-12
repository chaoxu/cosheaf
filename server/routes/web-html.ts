// Auto-escaping HTML templating for the server-rendered web layer, on top of
// hono/html. Every interpolated value in an html`` template is escaped unless
// it is itself an Html fragment (or wrapped in raw()). Markup-producing
// functions take and return `Html`, so a plain string can't cross a fragment
// boundary unescaped without the compiler objecting; String() coercion happens
// once, at the page/response boundary.

import { html as honoHtml, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Html = HtmlEscapedString;

// hono's html`` is typed to return a promise when interpolating promises; we
// never interpolate promises (async fragments are awaited by the caller), so
// narrow to the synchronous fragment type.
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  return honoHtml(strings, ...values) as Html;
}

export { raw };

// Empty fragment for "render nothing" branches where a typed Html is needed.
export const emptyHtml: Html = raw("");

// Join fragments without losing escaped-ness (Array.prototype.join returns a
// plain string, which a template would re-escape).
export function joinHtml(fragments: readonly Html[], separator: Html = emptyHtml): Html {
  return fragments.length === 0 ? emptyHtml : fragments.reduce((acc, f) => html`${acc}${separator}${f}`);
}
