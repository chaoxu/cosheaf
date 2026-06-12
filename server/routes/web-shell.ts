import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { escapeAttr, escapeHtml } from "./html-escape.js";

export type StatusCrumb = { label: string; href?: string };

export function pageShell(opts: {
  title: string;
  user?: string;
  body: string;
  readerAssets?: boolean;
  sidebar?: string;
  statusPath?: StatusCrumb[];
}): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(opts.title)} - Cosheaf</title>
        ${
          opts.readerAssets
            ? `<link rel="stylesheet" href="/vendor/coflat/editor.css">
        <link rel="stylesheet" href="/vendor/coflat/themes/blueprint-book.css">`
            : ""
        }
        ${opts.readerAssets ? webReaderAssets() : ""}
        <link rel="stylesheet" href="/cosheaf-web.css${cosheafWebCssVersion()}">
      </head>
      <body data-cosheaf-user="${escapeAttr(opts.user ?? "")}">
        <div class="app-frame">
          <div class="app-main">
            ${opts.sidebar ? `<aside class="app-sidebar">${opts.sidebar}</aside>` : ""}
            <div class="app-content">${opts.body}</div>
          </div>
          ${appStatusbar(opts.user, opts.statusPath)}
        </div>
      </body>
    </html>`;
}

function cosheafWebCssVersion(): string {
  const version = process.env.COSHEAF_GIT_SHA?.slice(0, 12);
  return version ? `?v=${encodeURIComponent(version)}` : "";
}

export function globalSidebar(active: "workspaces" | "account"): string {
  return `<a class="brand" href="/">Cosheaf</a>
    <nav class="repo-tabs">
      <a class="${active === "workspaces" ? "active" : ""}" href="/">Workspaces</a>
      <a class="${active === "account" ? "active" : ""}" href="/account/settings">Account</a>
    </nav>`;
}

function appStatusbar(user: string | undefined, path: StatusCrumb[] | undefined): string {
  const crumbs = [
    `<a href="/">cosheaf</a>`,
    ...(path ?? []).map((segment) =>
      segment.href
        ? `<a href="${escapeAttr(segment.href)}">${escapeHtml(segment.label)}</a>`
        : `<span>${escapeHtml(segment.label)}</span>`,
    ),
  ].join(`<span class="status-sep">/</span>`);
  const session = user
    ? `<form method="post" action="/logout"><a class="account-link" href="/account/settings">${escapeHtml(user)}</a><button type="submit">sign out</button></form>`
    : `<a class="account-link" href="/login">sign in</a>`;
  return `<footer class="app-statusbar"><span class="status-path">${crumbs}</span><div class="status-editor-slot"></div><div class="status-session">${session}</div></footer>`;
}

export function webEditorAssets(): string {
  return viteEntryAssets("src/cosheaf/web-editor.tsx");
}

type ViteManifestChunk = {
  file: string;
  css?: string[];
  imports?: string[];
};

let manifestCache: Record<string, ViteManifestChunk> | null | undefined;

function webReaderAssets(): string {
  return viteEntryAssets("src/cosheaf/web-reader.ts");
}

function viteEntryAssets(entryId: string): string {
  if (process.env.NODE_ENV !== "production") {
    const devOrigin = process.env.COSHEAF_VITE_ORIGIN ?? "http://localhost:5173";
    return `<script type="module" src="${devOrigin}/${entryId}"></script>`;
  }
  const manifest = readViteManifest();
  if (!manifest) return "";
  const entry = manifest[entryId];
  if (!entry) return "";
  const cssLinks = collectCss(manifest, entry, new Set<string>())
    .map((href) => `<link rel="stylesheet" href="/${escapeAttr(href)}">`)
    .join("");
  return `${cssLinks}<script type="module" src="/${escapeAttr(entry.file)}"></script>`;
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
