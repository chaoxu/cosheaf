import type { DocumentFormat } from "./document-format/types.js";
import { coflatMarkdownFormat } from "./document-format/coflat.js";
import { forgejoPassthroughFormat } from "./document-format/forgejo-passthrough.js";
import {
  COFLAT_FORMAT_ID,
  FORGEJO_PASSTHROUGH_FORMAT_ID,
  normalizeDocumentFormatId,
  type DocumentFormatId,
} from "../shared/document-format.js";

const formats: Record<DocumentFormatId, DocumentFormat> = {
  [COFLAT_FORMAT_ID]: coflatMarkdownFormat,
  [FORGEJO_PASSTHROUGH_FORMAT_ID]: forgejoPassthroughFormat,
};

export function getDocumentFormat(id: string | null | undefined): DocumentFormat {
  return formats[normalizeDocumentFormatId(id)] ?? forgejoPassthroughFormat;
}

export function allDocumentFormats(): DocumentFormat[] {
  return Object.values(formats);
}
