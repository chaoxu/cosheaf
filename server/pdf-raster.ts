// Render a PDF's first page to a PNG so PDF figures (`![](fig.pdf)` — common in
// papers exported from LaTeX `\includegraphics`) display in an <img>, which can't
// show a PDF directly. Pure-wasm (pdfium via @hyzyla/pdfium + pngjs): no native
// build, so it works in the offline local Workbench and the hosted server alike,
// behind the shared asset seam (resolveAssetUrl → /raw/...?preview=png).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { PNG } from "pngjs";

// One wasm instance, initialized lazily and reused across renders.
let libPromise: ReturnType<typeof PDFiumLibrary.init> | null = null;
function library(): ReturnType<typeof PDFiumLibrary.init> {
  return (libPromise ??= PDFiumLibrary.init());
}

// Serialize renders: a single wasm instance is not safe to drive concurrently, so
// chain calls. Each render is single-digit ms, so the queue is cheap.
let renderQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RasterizeOptions {
  // Render scale (2 = 2× the PDF's point size, a crisp default for figures).
  scale?: number;
  // Directory for the content-addressed PNG cache (skip caching when absent).
  cacheDir?: string;
}

// Render page 1 of `bytes` to a PNG buffer. Content-addressed: the same PDF +
// scale always yields the same cache key, so a figure is rasterized once.
export async function rasterizePdfFirstPage(bytes: Buffer, opts: RasterizeOptions = {}): Promise<Buffer> {
  const scale = opts.scale ?? 2;
  const key = createHash("sha1").update(bytes).update(`:v1:${scale}`).digest("hex");
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${key}.png`) : null;
  if (cacheFile && existsSync(cacheFile)) return readFileSync(cacheFile);

  const png = await serialized(async () => {
    const lib = await library();
    const doc = await lib.loadDocument(bytes);
    try {
      const img = await doc.getPage(0).render({ scale, render: "bitmap" });
      const out = new PNG({ width: img.width, height: img.height });
      // pdfium emits BGRA; pngjs wants RGBA — swap the blue/red channels.
      const src = img.data;
      for (let i = 0; i < src.length; i += 4) {
        out.data[i] = src[i + 2];
        out.data[i + 1] = src[i + 1];
        out.data[i + 2] = src[i];
        out.data[i + 3] = src[i + 3];
      }
      return PNG.sync.write(out);
    } finally {
      doc.destroy();
    }
  });

  if (cacheFile) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, png);
    } catch (_err) {
      // A read-only/odd cache dir shouldn't fail the render — just skip caching.
    }
  }
  return png;
}
