import type { DocumentFormat } from "./document-format/types.js";
import { coflatMarkdownFormat } from "./document-format/coflat.js";
import { forgejoPassthroughFormat } from "./document-format/forgejo-passthrough.js";
import { normalizeDocumentFormatId } from "../shared/document-format.js";

const formats = new Map<string, DocumentFormat>();

export function registerDocumentFormat(format: DocumentFormat): void {
  formats.set(format.id, format);
}

export function getDocumentFormat(id: string | null | undefined): DocumentFormat {
  return formats.get(normalizeDocumentFormatId(id)) ?? forgejoPassthroughFormat;
}

export function allDocumentFormats(): DocumentFormat[] {
  return [...formats.values()];
}

registerDocumentFormat(coflatMarkdownFormat);
registerDocumentFormat(forgejoPassthroughFormat);
