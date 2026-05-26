import path from "node:path";
import { TextDecoder } from "node:util";
import { fileContentTypeForPath, fileExtension, fileKindInfoForPath, rawRepositoryContentTypeForPath } from "../shared/file-kind.js";

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
const rawTextPlain = "text/plain; charset=utf-8";
const textSniffBytes = 8192;

export function repositoryRawHeadersForPath(filePath: string, content?: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": rawContentTypeForPath(filePath, content),
    "x-content-type-options": "nosniff",
  };
  if (rawSandboxExtensions.has(fileExtension(filePath))) {
    headers["content-security-policy"] = rawSandboxCsp;
  }
  return headers;
}

function rawContentTypeForPath(filePath: string, content?: Uint8Array): string {
  const info = fileKindInfoForPath(filePath);
  if (info.kind === "binary" && content && isLikelyTextContent(content)) return rawTextPlain;
  return rawRepositoryContentTypeForPath(filePath);
}

export function isLikelyTextContent(content: Uint8Array): boolean {
  const sample = content.subarray(0, Math.min(content.byteLength, textSniffBytes));
  if (sample.byteLength === 0) return true;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 27) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch (_err) {
    return false;
  }
}
