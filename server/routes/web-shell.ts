import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
      </head>
      <body data-cosheaf-user="${opts.user ?? ""}">
        <div class="app-frame">
          <div class="app-main">
            ${opts.sidebar ? html`<aside class="app-sidebar">${opts.sidebar}</aside>` : ""}
            <div class="app-content">${opts.body}</div>
          </div>
          ${appStatusbar(opts.user, opts.statusPath)}
        </div>
      </body>
    </html>`);
}

function cosheafWebCssVersion(): string {
  const version = process.env.COSHEAF_GIT_SHA?.slice(0, 12);
  return version ? `?v=${encodeURIComponent(version)}` : "";
}

export function globalSidebar(active: "workspaces" | "account"): Html {
  return html`<a class="brand" href="/">Cosheaf</a>
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">Workspaces</a>
      <a class="${active === "account" ? "active" : ""}" href="/account/settings">Account</a>
    </nav>`;
}

function appStatusbar(user: string | undefined, path: StatusCrumb[] | undefined): Html {
  const sep = html`<span class="status-sep">/</span>`;
  const crumbs = [
    html`<a href="/">cosheaf</a>`,
    ...(path ?? []).map((segment) =>
      segment.href
        ? html`<a href="${segment.href}">${segment.label}</a>`
        : html`<span>${segment.label}</span>`,
    ),
  ].flatMap((crumb, i) => (i === 0 ? [crumb] : [sep, crumb]));
  const session = user
    ? html`<form method="post" action="/logout"><a class="account-link" href="/account/settings">${user}</a><button type="submit">sign out</button></form>`
    : html`<a class="account-link" href="/login">sign in</a>`;
  return html`<footer class="app-statusbar"><span class="status-path">${crumbs}</span><div class="status-editor-slot"></div><div class="status-session">${session}</div></footer>`;
}

export function webEditorAssets(): Html {
  return viteEntryAssets("src/cosheaf/web-editor.tsx");
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
