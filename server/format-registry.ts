import type { DocumentFormat } from "./document-format/types.js";
import { coflatMarkdownFormat } from "./document-format/coflat.js";
import {
  COFLAT_FORMAT_ID,
  type DocumentFormatId,
} from "../shared/document-format.js";

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
