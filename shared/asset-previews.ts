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
