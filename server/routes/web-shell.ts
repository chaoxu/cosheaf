import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { avatarChip } from "./avatar.js";
import { emptyHtml, html, type Html, raw } from "./web-html.js";

export type StatusCrumb = { label: string; href?: string };

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
        <link rel="stylesheet" href="${`/cosheaf-web.css${cosheafWebCssVersion()}`}">
        <script src="/cosheaf-preferences.js" defer></script>
        <script src="/cosheaf-select.js" defer></script>
        ${opts.user ? raw(`<script src="/cosheaf-notifications.js" defer></script>`) : ""}
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
  return html`<a class="brand" href="/">Cosheaf</a>
    ${sidebarIdentity(user)}
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">Workspaces</a>
      ${notificationsNavLink(active === "notifications")}
      <a class="${active === "account" ? "active" : ""}" href="/account/settings">Account</a>
    </nav>`;
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
    html`<a href="/">cosheaf</a>`,
    ...(path ?? []).map((segment) =>
      segment.href
        ? html`<a href="${segment.href}">${segment.label}</a>`
        : html`<span>${segment.label}</span>`,
    ),
  ].flatMap((crumb, i) => (i === 0 ? [crumb] : [sep, crumb]));
  return html`<footer class="app-statusbar"><span class="status-path">${crumbs}</span><div class="status-editor-slot"></div></footer>`;
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
