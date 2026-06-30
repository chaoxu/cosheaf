const PDF_EXT = ".pdf";
const IMAGE_PREVIEW_EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".svg"] as const;

export type AssetPreviewPaths = Record<string, string>;

function extensionStart(path: string): number {
  const slash = path.lastIndexOf("/");
  return path.lastIndexOf(".", path.length - 1) > slash ? path.lastIndexOf(".") : -1;
}

function pathWithoutExtension(path: string): string | null {
  const dot = extensionStart(path);
  return dot >= 0 ? path.slice(0, dot) : null;
}

function extension(path: string): string {
  const dot = extensionStart(path);
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

export function buildPdfImagePreviewPaths(paths: readonly string[]): AssetPreviewPaths {
  const previewByBase = new Map<string, string>();
  for (const ext of IMAGE_PREVIEW_EXTENSIONS) {
    for (const path of paths) {
      if (extension(path) !== ext) continue;
      const base = pathWithoutExtension(path);
      if (base && !previewByBase.has(base.toLowerCase())) previewByBase.set(base.toLowerCase(), path);
    }
  }

  const previews: AssetPreviewPaths = {};
  for (const path of paths) {
    if (extension(path) !== PDF_EXT) continue;
    const base = pathWithoutExtension(path);
    const preview = base ? previewByBase.get(base.toLowerCase()) : undefined;
    if (preview) previews[path] = preview;
  }
  return previews;
}

export function previewAssetPath(path: string, previews?: AssetPreviewPaths): string {
  return previews?.[path] ?? path;
}

export function isPdfAssetPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

// The query the raw route understands to serve a PDF's first page rendered to
// PNG instead of the un-displayable PDF bytes.
export const PDF_PREVIEW_QUERY = "preview=png";

// Suffix appended to a *display* asset URL that points at a PDF with no sibling
// raster: it asks the raw route to rasterize page 1 so an <img> can show it.
export function pdfDisplaySuffix(assetPath: string): string {
  return isPdfAssetPath(assetPath) ? `?${PDF_PREVIEW_QUERY}` : "";
}
