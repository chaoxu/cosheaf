import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { avatar } from "./avatar.js";
import { DEFAULT_LOCALE, localeDir, type LocaleId, makeT, type T } from "../../shared/i18n/index.js";
import { emptyHtml, html, type Html, jsonScript, raw } from "./web-html.js";

// English-bound translate, used as the default for chrome helpers whose call
// sites haven't been threaded the request `t` yet (incremental rollout). Wired
// call sites pass the real per-request `t` and render the active locale.
const enT: T = makeT(DEFAULT_LOCALE);

// A breadcrumb segment. `wsTitle` carries the workspace's Read-mode title
// alongside the slug `label`; `cls` marks the owner segment so Read mode can
// hide it and surface the title instead (#147). Both are unset for plain crumbs.
export type StatusCrumb = { label: string; href?: string; cls?: string; wsTitle?: string };

export function pageShell(opts: {
  title: string;
  user?: string;
  body: Html;
  readerAssets?: boolean;
  sidebar?: Html;
  statusPath?: StatusCrumb[];
  locale?: LocaleId;
}): string {
  // Default to en when a caller hasn't been wired to pass the request locale yet
  // (incremental rollout); the seam still renders correct lang/dir per page.
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return String(html`<!doctype html>
    <html lang="${locale}" dir="${localeDir(locale)}">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${opts.title} - Cosheaf</title>
        ${
          opts.readerAssets
            ? raw(`<link rel="stylesheet" href="/vendor/coflat/editor.css">
        <link rel="stylesheet" href="/vendor/coflat/themes/blueprint-book.css">`)
            : ""
        }
        ${opts.readerAssets ? webReaderAssets() : ""}
        ${opts.user ? html`<script>(function(){try{var u=${jsonScript(opts.user)};var L=localStorage.getItem("cosheaf:landing-mode:"+u);var m=(L==="read"||L==="build")?L:(localStorage.getItem("cosheaf:mode:"+u)==="read"?"read":"build");document.documentElement.setAttribute("data-cosheaf-mode",m);}catch(e){}})();</script>` : ""}
        <script>(function(){try{var u=${jsonScript(opts.user ?? "")};var s=localStorage.getItem(u?"cosheaf:color-scheme:"+u:"cosheaf:color-scheme")||localStorage.getItem("cosheaf:color-scheme")||"light";if(s!=="dark"&&s!=="system")s="light";document.documentElement.setAttribute("data-cosheaf-color-scheme",s);var d=localStorage.getItem(u?"cosheaf:density:"+u:"cosheaf:density")||localStorage.getItem("cosheaf:density")||"normal";if(d!=="compact"&&d!=="comfortable"&&d!=="large")d="normal";document.documentElement.setAttribute("data-cosheaf-density",d);var rw=localStorage.getItem(u?"cosheaf:reading-width:"+u:"cosheaf:reading-width")||localStorage.getItem("cosheaf:reading-width")||"normal";if(rw!=="narrow"&&rw!=="wide")rw="normal";document.documentElement.setAttribute("data-cosheaf-reading",rw);}catch(e){}})();</script>
        <link rel="stylesheet" href="${`/cosheaf-web.css${cosheafWebCssVersion()}`}">
        <script src="/cosheaf-preferences.js" defer></script>
        <script src="/cosheaf-select.js" defer></script>
        ${opts.user ? raw(`<script src="/cosheaf-notifications.js" defer></script><script src="/cosheaf-mode.js" defer></script>`) : ""}
      </head>
      <body data-cosheaf-user="${opts.user ?? ""}" data-cosheaf-locale="${locale}">
        <div class="app-frame">
          <div class="app-main">
            ${opts.sidebar ? html`<aside class="app-sidebar">${opts.sidebar}</aside>` : ""}
            <div class="app-content">${opts.body}</div>
          </div>
          ${appStatusbar(opts.statusPath, makeT(locale))}
        </div>
      </body>
    </html>`);
}

function cosheafWebCssVersion(): string {
  const version = process.env.COSHEAF_GIT_SHA?.slice(0, 12);
  return version ? `?v=${encodeURIComponent(version)}` : "";
}

export function globalSidebar(active: "workspaces" | "account" | "notifications", user?: string, avatarSrc: string | null = null, t: T = enT): Html {
  return html`${sidebarIdentity(user, active === "notifications", avatarSrc, t)}
    ${user ? modeToggle(t) : ""}
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">${t("nav.workspaces")}</a>
    </nav>`;
}

// Per-user Read | Build chrome lens (#131). Read demotes the forge/contribute
// surface (issues, pulls, chat, activity, settings) to foreground the knowledge
// base (title-first files, reader, search); Build is the full forge surface and
// the default. The choice persists per user in localStorage and is applied as
// `html[data-cosheaf-mode]` before paint (see pageShell) so there's no flash;
// cosheaf-mode.js wires the toggle. Pure presentation — no routes change.
export function modeToggle(t: T = enT): Html {
  return html`<div class="mode-toggle" role="group" aria-label="View mode" data-mode-toggle>
    <button type="button" class="mode-opt" data-mode="read">${t("mode.read")}</button>
    <button type="button" class="mode-opt" data-mode="build">${t("mode.build")}</button>
  </div>`;
}

// Signed-in identity at the top of the sidebar (#127): an initials avatar + the
// username (linking to Account) plus a notifications bell (#167). The same block
// renders in the global and repo sidebars so identity + notifications are always
// visible. Logged-out chrome (only the pre-auth message pages) shows a sign-in
// link instead — and no bell.
export function sidebarIdentity(user: string | undefined, notificationsActive = false, avatarSrc: string | null = null, t: T = enT): Html {
  if (!user) return html`<div class="sidebar-identity"><a class="sidebar-identity-link" href="/login">${t("auth.sign_in")}</a></div>`;
  return html`<div class="sidebar-identity">
    <a class="sidebar-identity-link" href="/account/settings" title="${t("nav.account")}">${avatar(user, avatarSrc)}<span class="sidebar-identity-name">${user}</span></a>
    ${notificationsBell(notificationsActive, t)}
  </div>`;
}

// Persistent notifications entry point (#129, #167): a bell beside the username
// carrying the unread-count badge. Replaces the old standalone "Notifications"
// nav link. The badge is filled client-side by cosheaf-notifications.js (kept
// live over the per-user SSE channel) against [data-notif-badge], so server
// renders stay cheap.
export function notificationsBell(active = false, t: T = enT): Html {
  return html`<a class="notif-bell${active ? " active" : ""}" href="/account/notifications" aria-label="${t("nav.notifications")}" title="${t("nav.notifications")}">
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.6a3.1 3.1 0 0 0-3.1 3.1c0 2.4-.55 3.55-1.15 4.25-.32.37-.06.95.42.95h7.66c.48 0 .74-.58.42-.95-.6-.7-1.15-1.85-1.15-4.25A3.1 3.1 0 0 0 8 1.6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.6 12.4a1.45 1.45 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    <span class="notif-badge" data-notif-badge hidden></span>
  </a>`;
}

function appStatusbar(path: StatusCrumb[] | undefined, t: T = enT): Html {
  const sep = html`<span class="status-sep">/</span>`;
  const crumbs = [
    html`<a class="status-home" href="/" aria-label="${t("nav.home")}" title="${t("nav.home")}">⌂</a>`,
    ...(path ?? []).map(renderCrumb),
  ].flatMap((crumb, i) => (i === 0 ? [crumb] : [sep, crumb]));
  return html`<footer class="app-statusbar"><span class="status-path">${crumbs}<span class="status-rename-slot"></span></span><div class="status-editor-slot"></div></footer>`;
}

function renderCrumb(segment: StatusCrumb): Html {
  // A workspace crumb carries both the slug label and the Read-mode title; CSS
  // swaps which is shown by mode. Plain crumbs render just their label.
  const inner = segment.wsTitle
    ? html`<span class="status-slug">${segment.label}</span><span class="status-title">${segment.wsTitle}</span>`
    : segment.label;
  const cls = segment.cls ? html` class="${segment.cls}"` : emptyHtml;
  return segment.href
    ? html`<a${cls} href="${segment.href}">${inner}</a>`
    : html`<span${cls}>${inner}</span>`;
}

export function webEditorAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-editor.tsx");
}

export function webCommentEditorAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-comment-editor.tsx");
}

type ViteManifestChunk = {
  file: string;
  css?: string[];
  imports?: string[];
};

let manifestCache: Record<string, ViteManifestChunk> | null | undefined;

function webReaderAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-reader.ts");
}

function viteEntryAssets(entryId: string): Html {
  if (process.env.NODE_ENV !== "production") {
    const devOrigin = process.env.COSHEAF_VITE_ORIGIN ?? "http://localhost:5173";
    return html`<script type="module" src="${`${devOrigin}/${entryId}`}"></script>`;
  }
  const manifest = readViteManifest();
  if (!manifest) return emptyHtml;
  const entry = manifest[entryId];
  if (!entry) return emptyHtml;
  const cssLinks = collectCss(manifest, entry, new Set<string>()).map(
    (href) => html`<link rel="stylesheet" href="/${href}">`,
  );
  return html`${cssLinks}<script type="module" src="/${entry.file}"></script>`;
}

function readViteManifest(): Record<string, ViteManifestChunk> | null {
  if (manifestCache !== undefined) return manifestCache;
  const manifestPath = path.resolve(process.cwd(), "dist/.vite/manifest.json");
  if (!existsSync(manifestPath)) {
    manifestCache = null;
    return manifestCache;
  }
  manifestCache = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ViteManifestChunk>;
  return manifestCache;
}

function collectCss(
  manifest: Record<string, ViteManifestChunk>,
  chunk: ViteManifestChunk,
  seen: Set<string>,
): string[] {
  const css: string[] = [];
  for (const imported of chunk.imports ?? []) {
    const importedChunk = manifest[imported];
    if (importedChunk) css.push(...collectCss(manifest, importedChunk, seen));
  }
  for (const href of chunk.css ?? []) {
    if (seen.has(href)) continue;
    seen.add(href);
    css.push(href);
  }
  return css;
}
