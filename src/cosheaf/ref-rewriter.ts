import DOMPurify from "dompurify";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml";

export const REF_PAGE_CLASS = "cosheaf-ref-page";
export const REF_BUTTON_CLASS = "cosheaf-ref-button";

// Cosheaf refs layered on top of rendered markdown text:
//   - path.md#L5-12 opens a file/line range
//   - #42 opens an issue
// Coflat owns [@...] cross-reference/citation rendering and hover behavior.
const BARE_REF_RE =
  /(^|[\s(])([\w./-]+\.md(?:#L\d+(?:-\d+)?|#[\w-]+)?|#\d+)(?=\b|[\s).,;:!?]|$)/g;

export function sanitizeAndRewriteRefs(rendered: string): string {
  return fragmentToHtml(sanitizeAndRewriteRefsFragment(rendered));
}

export function sanitizeAndRewriteRefsFragment(rendered: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(rendered, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  rewriteRefsInFragment(fragment);
  injectPageRefTestIds(fragment);
  return fragment;
}

export function plainTextToRefHtml(text: string): string {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(parseFrontmatterYaml(text).body));
  rewriteRefsInFragment(fragment);
  return fragmentToHtml(fragment);
}

function fragmentToHtml(fragment: DocumentFragment): string {
  const host = document.createElement("div");
  host.append(fragment);
  return host.innerHTML;
}

function rewriteRefsInFragment(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (shouldSkipTextNode(node)) continue;
    const replacement = rewriteRefTextNode(node);
    if (replacement) node.replaceWith(replacement);
  }
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  // .cf-bibliography is citeproc-owned prose (Coflat's reader-emitted References
  // list); a "#42"/"foo.md"/"[@key]" inside a title or note there is not a
  // cosheaf workspace ref and must not become a nav button.
  return parent?.closest("code, pre, a, .cf-math, .cosheaf-ref-page, .cf-bibliography") != null;
}

function rewriteRefTextNode(node: Text): DocumentFragment | null {
  const textRun = node.data;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let changed = false;
  BARE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_REF_RE.exec(textRun)) !== null) {
    const lead = m[1];
    const ref = m[2];
    const matchStart = m.index + lead.length;
    if (matchStart > cursor) fragment.append(document.createTextNode(textRun.slice(cursor, matchStart)));
    fragment.append(ref.startsWith("#") ? issueRefButton(ref) : pathRefButton(ref));
    cursor = m.index + lead.length + ref.length;
    changed = true;
  }
  if (!changed) return null;
  if (cursor < textRun.length) fragment.append(document.createTextNode(textRun.slice(cursor)));
  return fragment;
}

function issueRefButton(ref: string): HTMLButtonElement {
  const num = ref.slice(1);
  const button = document.createElement("button");
  button.type = "button";
  button.className = REF_BUTTON_CLASS;
  button.dataset.refKind = "num";
  button.dataset.refNum = num;
  button.dataset.testid = `ref-num-${num}`;
  button.textContent = ref;
  return button;
}

function pathRefButton(ref: string): HTMLButtonElement {
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
  return button;
}

function injectPageRefTestIds(root: DocumentFragment): void {
  for (const el of root.querySelectorAll<HTMLElement>(`.${REF_PAGE_CLASS}[data-ref-key]`)) {
    const key = el.dataset.refKey;
    if (key) el.dataset.testid = `ref-page-${key}`;
  }
}
