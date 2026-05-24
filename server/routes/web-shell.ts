import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function pageShell(opts: { title: string; user?: string; body: string }): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(opts.title)} - Cosheaf</title>
        <link rel="stylesheet" href="/vendor/coflat-editor/editor.css">
        <link rel="stylesheet" href="/vendor/coflat-editor/themes/blueprint-book.css">
        ${webReaderAssets()}
        <link rel="stylesheet" href="/cosheaf-web.css">
      </head>
      <body data-cosheaf-user="${escapeAttr(opts.user ?? "")}">${opts.body}</body>
    </html>`;
}

export function globalHeader(user: string): string {
  return `<header class="global-header">
    <a class="brand" href="/">Cosheaf</a>
    <form method="post" action="/logout"><a class="account-link" href="/account/settings">${escapeHtml(user)}</a><button type="submit">Sign out</button></form>
  </header>`;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
