// HTML-text and HTML-attribute escaping. Two flavors:
//   - escapeHtml: text content. Covers & < > " '.
//   - escapeAttr: attribute values inside double-quoted attributes. The
//     reduced set (& < ") is what we minimally need; > and ' don't break
//     a `"..."` attribute, but we keep them out of escapeAttr for output
//     terseness. Use escapeHtml if you need maximum safety in attrs too.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
