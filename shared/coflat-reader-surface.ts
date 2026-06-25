export const COFLAT_READER_ARTICLE_CLASS = "document cosheaf-document-reader cf-theme-scope";
export const COFLAT_READER_SURFACE_CLASS = "cf-reader cf-doc-surface cf-doc-flow";
export const COFLAT_READER_ISLAND_CLASS = `${COFLAT_READER_SURFACE_CLASS} coflat-reader-island`;
export const COFLAT_FILE_PREVIEW_TEST_ID = "file-preview-markdown";

export type CoflatReaderSurface = "document" | "thread" | "diff";

export function coflatReaderSurfaceClass(surface: CoflatReaderSurface = "document"): string {
  const surfaceClass = surface === "thread" ? "cf-reader-compact" : surface === "diff" ? "cf-rich-diff cf-reader-compact" : "";
  return [COFLAT_READER_SURFACE_CLASS, surfaceClass].filter(Boolean).join(" ");
}

export function coflatReaderIslandClass(surface: CoflatReaderSurface = "document"): string {
  return [coflatReaderSurfaceClass(surface), "coflat-reader-island"].join(" ");
}
