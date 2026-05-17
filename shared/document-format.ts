export const COFLAT_FORMAT_ID = "coflat";
export const FORGEJO_PASSTHROUGH_FORMAT_ID = "forgejo-passthrough";

export type DocumentFormatId = typeof COFLAT_FORMAT_ID | typeof FORGEJO_PASSTHROUGH_FORMAT_ID;

export const DEFAULT_DOCUMENT_FORMAT_ID: DocumentFormatId = FORGEJO_PASSTHROUGH_FORMAT_ID;

export function isDocumentFormatId(value: unknown): value is DocumentFormatId {
  return value === COFLAT_FORMAT_ID || value === FORGEJO_PASSTHROUGH_FORMAT_ID;
}

export function normalizeDocumentFormatId(value: unknown): DocumentFormatId {
  return isDocumentFormatId(value) ? value : DEFAULT_DOCUMENT_FORMAT_ID;
}
