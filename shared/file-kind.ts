export type FileKind = "markdown" | "text" | "pdf" | "image" | "binary";

export interface FileKindInfo {
  kind: FileKind;
  label: string;
  contentType: string;
  rawContentType?: string;
}

const textPlain = "text/plain; charset=utf-8";

const fileKindsByExtension: Record<string, FileKindInfo> = {
  ".bib": { kind: "text", label: "Text", contentType: textPlain },
  ".conf": { kind: "text", label: "Text", contentType: textPlain },
  ".csv": { kind: "text", label: "Text", contentType: "text/csv; charset=utf-8" },
  ".css": { kind: "text", label: "Text", contentType: "text/css; charset=utf-8" },
  ".env": { kind: "text", label: "Text", contentType: textPlain },
  ".html": { kind: "text", label: "Text", contentType: "text/html; charset=utf-8", rawContentType: textPlain },
  ".htm": { kind: "text", label: "Text", contentType: "text/html; charset=utf-8", rawContentType: textPlain },
  ".ini": { kind: "text", label: "Text", contentType: textPlain },
  ".js": { kind: "text", label: "Text", contentType: "text/javascript; charset=utf-8", rawContentType: textPlain },
  ".json": { kind: "text", label: "Text", contentType: "application/json; charset=utf-8" },
  ".jsonl": { kind: "text", label: "Text", contentType: textPlain },
  ".log": { kind: "text", label: "Text", contentType: textPlain },
  ".md": { kind: "markdown", label: "Markdown", contentType: "text/markdown; charset=utf-8" },
  ".mjs": { kind: "text", label: "Text", contentType: "text/javascript; charset=utf-8", rawContentType: textPlain },
  ".pdf": { kind: "pdf", label: "PDF", contentType: "application/pdf" },
  ".sql": { kind: "text", label: "Text", contentType: textPlain },
  ".tex": { kind: "text", label: "Text", contentType: textPlain },
  ".toml": { kind: "text", label: "Text", contentType: textPlain },
  ".ts": { kind: "text", label: "Text", contentType: textPlain },
  ".tsx": { kind: "text", label: "Text", contentType: textPlain },
  ".txt": { kind: "text", label: "Text", contentType: textPlain },
  ".xml": { kind: "text", label: "Text", contentType: textPlain },
  ".yaml": { kind: "text", label: "Text", contentType: textPlain },
  ".yml": { kind: "text", label: "Text", contentType: textPlain },
  ".gif": { kind: "image", label: "Image", contentType: "image/gif" },
  ".jpeg": { kind: "image", label: "Image", contentType: "image/jpeg" },
  ".jpg": { kind: "image", label: "Image", contentType: "image/jpeg" },
  ".png": { kind: "image", label: "Image", contentType: "image/png" },
  ".svg": { kind: "image", label: "Image", contentType: "image/svg+xml" },
  ".webp": { kind: "image", label: "Image", contentType: "image/webp" },
};

const fallbackFileKind: FileKindInfo = {
  kind: "binary",
  label: "File",
  contentType: "application/octet-stream",
};

export function fileExtension(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const dot = filePath.lastIndexOf(".");
  return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

export function fileKindForPath(filePath: string): FileKind {
  return fileKindInfoForPath(filePath).kind;
}

export function fileKindLabel(kind: FileKind): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "text") return "Text";
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "Image";
  return "File";
}

export function fileKindInfoForPath(filePath: string): FileKindInfo {
  return fileKindsByExtension[fileExtension(filePath)] ?? fallbackFileKind;
}

export function fileContentTypeForPath(filePath: string): string {
  return fileKindInfoForPath(filePath).contentType;
}

export function rawRepositoryContentTypeForPath(filePath: string): string {
  const info = fileKindInfoForPath(filePath);
  return info.rawContentType ?? info.contentType;
}
