export function normalizeCoflatReaderDom(root: HTMLElement): void {
  for (const heading of root.querySelectorAll<HTMLElement>(".cf-doc-heading")) {
    stripPandocHeadingAttributes(heading);
  }
}

function stripPandocHeadingAttributes(heading: HTMLElement): void {
  const last = lastTextNode(heading);
  if (!last) return;
  const original = last.nodeValue ?? "";
  const next = original.replace(/\s+\{([^}]*)\}\s*$/, (_match, attrs: string) => {
    const tokens = attrs.trim().split(/\s+/);
    if (tokens.includes("-") || tokens.includes(".unnumbered")) {
      heading.classList.add("cf-doc-heading--unnumbered");
    }
    return "";
  });
  if (next !== original) last.nodeValue = next;
}

function lastTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let current = walker.nextNode();
  while (current) {
    last = current as Text;
    current = walker.nextNode();
  }
  return last;
}
