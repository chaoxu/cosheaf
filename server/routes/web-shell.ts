import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { avatarChip } from "./avatar.js";
import { emptyHtml, html, type Html, jsonScript, raw } from "./web-html.js";

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
}): string {
  return String(html`<!doctype html>
    <html lang="en">
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
        ${opts.user ? raw(`<script src="/cosheaf-notifications.js" defer></script><script src="/cosheaf-mode.js" defer></script><script src="/cosheaf-avatar.js" defer></script>`) : ""}
      </head>
      <body data-cosheaf-user="${opts.user ?? ""}">
        <div class="app-frame">
          <div class="app-main">
            ${opts.sidebar ? html`<aside class="app-sidebar">${opts.sidebar}</aside>` : ""}
            <div class="app-content">${opts.body}</div>
          </div>
          ${appStatusbar(opts.statusPath)}
        </div>
      </body>
    </html>`);
}

function cosheafWebCssVersion(): string {
  const version = process.env.COSHEAF_GIT_SHA?.slice(0, 12);
  return version ? `?v=${encodeURIComponent(version)}` : "";
}

export function globalSidebar(active: "workspaces" | "account" | "notifications", user?: string): Html {
  return html`<span class="brand">Cosheaf</span>
    ${sidebarIdentity(user)}
    ${user ? modeToggle() : ""}
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">Workspaces</a>
      ${notificationsNavLink(active === "notifications")}
    </nav>`;
}

// Per-user Read | Build chrome lens (#131). Read demotes the forge/contribute
// surface (issues, pulls, chat, activity, settings) to foreground the knowledge
// base (title-first files, reader, search); Build is the full forge surface and
// the default. The choice persists per user in localStorage and is applied as
// `html[data-cosheaf-mode]` before paint (see pageShell) so there's no flash;
// cosheaf-mode.js wires the toggle. Pure presentation — no routes change.
export function modeToggle(): Html {
  return html`<div class="mode-toggle" role="group" aria-label="View mode" data-mode-toggle>
    <button type="button" class="mode-opt" data-mode="read">Read</button>
    <button type="button" class="mode-opt" data-mode="build">Build</button>
  </div>`;
}

// Signed-in identity directly under the brand (#127): an initials avatar + the
// username, linking to Account. The same block renders in the global and repo
// sidebars so identity is always visible at the top. Logged-out chrome (only the
// pre-auth message pages) shows a sign-in link instead.
export function sidebarIdentity(user: string | undefined): Html {
  if (!user) return html`<a class="sidebar-identity" href="/login">Sign in</a>`;
  return html`<a class="sidebar-identity" href="/account/settings" title="Account">${avatarChip(user)}<span class="sidebar-identity-name">${user}</span></a>`;
}

// Persistent global-notifications entry point (#129) shared by both sidebars.
// The unread count badge is filled client-side by cosheaf-notifications.js (and
// kept live over the per-user SSE channel), so server renders stay cheap.
export function notificationsNavLink(active: boolean): Html {
  return html`<a class="${active ? "active" : ""}" href="/account/notifications">Notifications<span class="notif-badge" data-notif-badge hidden></span></a>`;
}

function appStatusbar(path: StatusCrumb[] | undefined): Html {
  const sep = html`<span class="status-sep">/</span>`;
  const crumbs = [
    html`<a class="status-home" href="/" aria-label="Home" title="Home">⌂</a>`,
    ...(path ?? []).map(renderCrumb),
  ].flatMap((crumb, i) => (i === 0 ? [crumb] : [sep, crumb]));
  return html`<footer class="app-statusbar"><span class="status-path">${crumbs}</span><div class="status-editor-slot"></div></footer>`;
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
