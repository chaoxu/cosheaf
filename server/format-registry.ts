import type { DocumentFormat } from "./document-format/types.js";
import { coflatMarkdownFormat } from "./document-format/coflat.js";
import {
  COFLAT_FORMAT_ID,
  type DocumentFormatId,
} from "../shared/document-format.js";

// Coflat is the only runtime document format. This registry remains as a small
// compatibility wrapper for older indexing/validation call sites that still pass
// a historical `default_md_format` value.
const formats: Record<DocumentFormatId, DocumentFormat> = {
  [COFLAT_FORMAT_ID]: coflatMarkdownFormat,
};

export function getDocumentFormat(id: string | null | undefined): DocumentFormat {
  void id;
  return coflatMarkdownFormat;
}

export function allDocumentFormats(): DocumentFormat[] {
  return Object.values(formats);
}
