// The one icon source (#186). Lucide ships each icon as framework-agnostic node
// data (the `[tag, attrs, children]` arrays lucide-react is built on); we render
// that to an inline-SVG string here. This module is isomorphic: server chrome
// wraps the string in `raw()` (server/routes/icons.ts) and client islands feed it
// to `dangerouslySetInnerHTML`, so neither hand-draws SVG paths and both stay in
// lockstep with the same lucide geometry.

import { Bell, ChevronLeft, ChevronRight, CircleHelp, Eye, GitBranch, Home, Pencil, Settings } from "lucide";

export type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>, IconNode?]>;

export interface IconOpts {
  size?: number;
  class?: string;
}

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

// Inline SVG markup for a lucide icon. aria-hidden because these sit beside a
// text label that already carries the meaning.
export function iconMarkup(node: IconNode, opts: IconOpts = {}): string {
  const size = opts.size ?? 16;
  const className = opts.class ? `lucide ${escapeAttr(opts.class)}` : "lucide";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${className}" aria-hidden="true">${renderChildren(node)}</svg>`;
}

const asNode = (icon: unknown): IconNode => icon as IconNode;

// The curated icon set Cosheaf uses, keyed by role. Add entries here (not inline
// SVG) so every surface draws from one place.
export const lucideIcons = {
  branch: asNode(GitBranch),
  chevron: asNode(ChevronRight),
  home: asNode(Home),
  back: asNode(ChevronLeft),
  bell: asNode(Bell),
  help: asNode(CircleHelp),
  pencil: asNode(Pencil),
  eye: asNode(Eye),
  settings: asNode(Settings),
} as const;
