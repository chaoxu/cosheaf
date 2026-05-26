import path from "node:path";
import { fileContentTypeForPath, fileExtension, rawRepositoryContentTypeForPath } from "../shared/file-kind.js";

export function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    default:
      return fileContentTypeForPath(filePath);
  }
}

const rawSandboxCsp = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'unsafe-inline'",
  "sandbox",
].join("; ");

const rawSandboxExtensions = new Set([".html", ".htm", ".svg", ".xml"]);

export function repositoryRawHeadersForPath(filePath: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": rawRepositoryContentTypeForPath(filePath),
    "x-content-type-options": "nosniff",
  };
  if (rawSandboxExtensions.has(fileExtension(filePath))) {
    headers["content-security-policy"] = rawSandboxCsp;
  }
  return headers;
}
