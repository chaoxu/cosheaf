// Server-rendered chrome icons (#186): thin wrappers that render the shared
// lucide node data (shared/lucide.ts) to an inline-SVG `Html`. Call sites use the
// named helpers below — never raw icon markup — so the whole set stays swappable
// and islands reuse the very same `iconMarkup`/`lucideIcons` source.
import { type IconOpts, iconMarkup, lucideIcons } from "../../shared/lucide.js";
import { type Html, raw } from "./web-html.js";

export type { IconOpts };

export const branchIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.branch, opts));
// Disclosure chevron: points right when closed, rotated to down on [open] by CSS
// (so one icon serves both states), replacing the ▸/▾ glyphs.
export const chevronIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.chevron, opts));
export const homeIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.home, opts));
export const backIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.back, opts));
export const bellIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.bell, opts));
export const editIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.pencil, opts));
export const eyeIcon = (opts?: IconOpts): Html => raw(iconMarkup(lucideIcons.eye, opts));
