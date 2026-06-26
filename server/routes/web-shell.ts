import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_LOCALE, type LocaleId, localeDir, makeT, type T } from "../../shared/i18n/index.js";
import { viteDevOrigin } from "../vite-dev-origin.js";
import { avatar } from "./avatar.js";
import { bellIcon, helpIcon, homeIcon, settingsIcon } from "./icons.js";
import { emptyHtml, type Html, html, jsonScript, raw } from "./web-html.js";

// English-bound translate, used as the default for chrome helpers whose call
// sites haven't been threaded the request `t` yet (incremental rollout). Wired
// call sites pass the real per-request `t` and render the active locale.
const enT: T = makeT(DEFAULT_LOCALE);
const requireResolve = createRequire(import.meta.url).resolve;

// A breadcrumb segment. `wsTitle` carries the workspace title alongside the
// slug `label`; current chrome keeps the slug primary.
export type StatusCrumb = { label: string; href?: string; cls?: string; wsTitle?: string; icon?: Html };

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
            ? raw(`<link rel="stylesheet" href="/vendor/coflat/document-surface.css${coflatVendorCssVersion("document-surface.css")}">
        <link rel="stylesheet" href="/vendor/coflat/themes/blueprint-book.css${coflatVendorCssVersion("themes/blueprint-book.css")}">`)
            : ""
        }
        ${opts.readerAssets ? webReaderAssets() : ""}
        <script>(function(){try{var u=${jsonScript(opts.user ?? "")};var s=localStorage.getItem(u?"cosheaf:color-scheme:"+u:"cosheaf:color-scheme")||localStorage.getItem("cosheaf:color-scheme")||"light";if(s!=="dark"&&s!=="system")s="light";document.documentElement.setAttribute("data-cosheaf-color-scheme",s);var d=localStorage.getItem(u?"cosheaf:density:"+u:"cosheaf:density")||localStorage.getItem("cosheaf:density")||"normal";if(d!=="compact"&&d!=="comfortable"&&d!=="large")d="normal";document.documentElement.setAttribute("data-cosheaf-density",d);var rw=localStorage.getItem(u?"cosheaf:reading-width:"+u:"cosheaf:reading-width")||localStorage.getItem("cosheaf:reading-width")||"normal";if(rw!=="narrow"&&rw!=="wide")rw="normal";document.documentElement.setAttribute("data-cosheaf-reading",rw);var fl=localStorage.getItem(u?"cosheaf:file-labels:"+u:"cosheaf:file-labels")||localStorage.getItem("cosheaf:file-labels")||"filename";if(fl!=="title")fl="filename";document.documentElement.setAttribute("data-cosheaf-file-labels",fl);var lr=localStorage.getItem("cosheaf:left-rail");if(lr==="collapsed")document.documentElement.setAttribute("data-cosheaf-left-rail","collapsed");var rr=localStorage.getItem("cosheaf:right-rail");if(rr==="collapsed")document.documentElement.setAttribute("data-cosheaf-right-rail","collapsed");}catch(e){}})();</script>
        <link rel="stylesheet" href="${`/cosheaf-web.css${cosheafWebCssVersion()}`}">
        <script src="/cosheaf-preferences.js" defer></script>
        <script src="/cosheaf-select.js" defer></script>
        <script src="/cosheaf-toast.js" defer></script>
        <script src="/cosheaf-rails.js" defer></script>
        <script src="/cosheaf-diff-nav.js" defer></script>
        ${opts.user ? raw(`<script src="/cosheaf-notifications.js" defer></script>`) : ""}
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

const coflatVendorCssVersions = new Map<string, string>();

function coflatVendorCssVersion(exportPath: "document-surface.css" | "themes/blueprint-book.css"): string {
  const cached = coflatVendorCssVersions.get(exportPath);
  if (cached !== undefined) return cached;
  try {
    const filePath = requireResolve(`@chaoxu/coflat/${exportPath}`);
    const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 12);
    const version = `?v=${encodeURIComponent(hash)}`;
    coflatVendorCssVersions.set(exportPath, version);
    return version;
  } catch (_error) {
    coflatVendorCssVersions.set(exportPath, "");
    return "";
  }
}

export function globalSidebar(
  active: "workspaces" | "account" | "notifications" | "admin" | "help",
  user?: string,
  avatarSrc: string | null = null,
  t: T = enT,
  opts: { siteAdmin?: boolean } = {},
): Html {
  return html`${sidebarIdentity(user, active === "notifications", avatarSrc, t, active === "account", active === "help")}
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">${t("nav.workspaces")}</a>
      ${opts.siteAdmin ? html`<a class="${active === "admin" ? "active" : ""}" href="/admin">Admin</a>` : emptyHtml}
    </nav>`;
}

// Signed-in identity at the top of the sidebar (#127): an initials avatar + the
// username linking to the user's profile, plus notifications/settings icons.
// The same block renders in the global and repo sidebars so identity + chrome
// actions are always visible. Logged-out chrome (only the pre-auth message
// pages) shows a sign-in link instead — and no action icons.
export function sidebarIdentity(user: string | undefined, notificationsActive = false, avatarSrc: string | null = null, t: T = enT, settingsActive = false, helpActive = false): Html {
  if (!user) return html`<div class="sidebar-identity"><a class="sidebar-identity-link" href="/login">${t("auth.sign_in")}</a></div>`;
  return html`<div class="sidebar-identity">
    <a class="sidebar-identity-link" href="${profileHref(user)}" title="${t("nav.profile")}">${avatar(user, avatarSrc)}<span class="sidebar-identity-name">${user}</span></a>
    ${notificationsBell(notificationsActive, t)}
    ${helpCircle(helpActive, t)}
    ${settingsGear(settingsActive, t)}
  </div>`;
}

function profileHref(user: string): string {
  return `/users/${encodeURIComponent(user)}`;
}

// Persistent notifications entry point (#129, #167): a bell beside the username
// carrying the unread-count badge. Replaces the old standalone "Notifications"
// nav link. The badge is filled client-side by cosheaf-notifications.js (kept
// live over the per-user SSE channel) against [data-notif-badge], so server
// renders stay cheap.
export function notificationsBell(active = false, t: T = enT): Html {
  return html`<a class="notif-bell${active ? " active" : ""}" href="/account/notifications" aria-label="${t("nav.notifications")}" title="${t("nav.notifications")}">
    ${bellIcon({ size: 15 })}
    <span class="notif-badge" data-notif-badge hidden></span>
  </a>`;
}

export function helpCircle(active = false, t: T = enT): Html {
  return html`<a class="help-circle${active ? " active" : ""}" href="/help" aria-label="${t("nav.help")}" title="${t("nav.help")}">
    ${helpIcon({ size: 15 })}
  </a>`;
}

export function settingsGear(active = false, t: T = enT): Html {
  return html`<a class="settings-gear${active ? " active" : ""}" href="/account/settings" aria-label="${t("settings.title")}" title="${t("settings.title")}">
    ${settingsIcon({ size: 15 })}
  </a>`;
}

function appStatusbar(path: StatusCrumb[] | undefined, t: T = enT): Html {
  const sep = html`<span class="status-sep">/</span>`;
  const crumbs = [
    html`<a class="status-home" href="/" aria-label="${t("nav.home")}" title="${t("nav.home")}">${homeIcon({ size: 14 })}</a>`,
    ...(path ?? []).map(renderCrumb),
  ].flatMap((crumb, i) => (i === 0 ? [crumb] : [sep, crumb]));
  return html`<footer class="app-statusbar"><span class="status-path">${crumbs}<span class="status-rename-slot"></span></span><div class="status-editor-slot"></div></footer>`;
}

function renderCrumb(segment: StatusCrumb): Html {
  // A workspace crumb carries both the slug label and the Read-mode title; CSS
  // swaps which is shown by mode. Plain crumbs render just their label.
  const label = segment.wsTitle
    ? html`<span class="status-slug">${segment.label}</span><span class="status-title">${segment.wsTitle}</span>`
    : segment.label;
  // An optional leading icon (e.g. the branch crumb in the editor) marks what
  // the segment is; CSS aligns it inline with the text.
  const inner = segment.icon ? html`${segment.icon}${label}` : label;
  const cls = segment.icon
    ? html` class="branch-ref${segment.cls ? ` ${segment.cls}` : ""}"`
    : segment.cls
      ? html` class="${segment.cls}"`
      : emptyHtml;
  return segment.href
    ? html`<a${cls} href="${segment.href}">${inner}</a>`
    : html`<span${cls}>${inner}</span>`;
}

export function webEditorAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-editor.tsx");
}

export function webEditShellAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-edit-shell.ts");
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
    return html`<script type="module" src="${`${viteDevOrigin()}/${entryId}`}"></script>`;
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
