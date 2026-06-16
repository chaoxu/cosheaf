import { Bell, ChevronLeft, ChevronRight, GitBranch, Home, Pencil } from "lucide";
import { type Html, raw } from "./web-html.js";

// Lucide icons, rendered once to inline SVG for the server-rendered chrome
// (#186). Call sites use the named helpers below — never raw icon markup — so
// the whole set stays swappable. Lucide ships each icon as framework-agnostic
// node data (the same `[tag, attrs, children]` arrays lucide-react is built on),
// so this is the React-free path; the produced markup also works inside an
// island via dangerouslySetInnerHTML if ever needed.
type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>, IconNode?]>;

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
}

function renderChildren(node: IconNode): string {
  return node
    .map(([tag, attrs, children]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
        .join(" ");
      return children?.length ? `<${tag} ${a}>${renderChildren(children)}</${tag}>` : `<${tag} ${a}/>`;
    })
    .join("");
}

export interface IconOpts {
  size?: number;
  class?: string;
}

function renderIcon(node: IconNode, opts: IconOpts = {}): Html {
  const size = opts.size ?? 16;
  const className = opts.class ? `lucide ${escapeAttr(opts.class)}` : "lucide";
  // Lucide's standard SVG frame; aria-hidden because these icons sit beside a
  // text label that already carries the meaning.
  return raw(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${className}" aria-hidden="true">${renderChildren(node)}</svg>`,
  );
}

const asNode = (icon: unknown): IconNode => icon as IconNode;

export const branchIcon = (opts?: IconOpts): Html => renderIcon(asNode(GitBranch), opts);
// Disclosure chevron: points right when closed, rotated to down on [open] by CSS
// (so one icon serves both states), replacing the ▸/▾ glyphs.
export const chevronIcon = (opts?: IconOpts): Html => renderIcon(asNode(ChevronRight), opts);
export const homeIcon = (opts?: IconOpts): Html => renderIcon(asNode(Home), opts);
export const backIcon = (opts?: IconOpts): Html => renderIcon(asNode(ChevronLeft), opts);
export const bellIcon = (opts?: IconOpts): Html => renderIcon(asNode(Bell), opts);
export const editIcon = (opts?: IconOpts): Html => renderIcon(asNode(Pencil), opts);
