export const COFLAT_FORMAT_ID = "coflat";

export type DocumentFormatId = typeof COFLAT_FORMAT_ID;

// Cosheaf markdown is Coflat markdown. These aliases remain while route and API
// shapes still carry the historic `default_md_format` field.
export const DEFAULT_DOCUMENT_FORMAT_ID: DocumentFormatId = COFLAT_FORMAT_ID;
export const DEFAULT_CREATE_FORMAT_ID: DocumentFormatId = COFLAT_FORMAT_ID;

export function isDocumentFormatId(value: unknown): value is DocumentFormatId {
  return value === COFLAT_FORMAT_ID;
}

export function normalizeDocumentFormatId(value: unknown): DocumentFormatId {
  return isDocumentFormatId(value) ? value : COFLAT_FORMAT_ID;
}

// Workspace marker convention. A `cosheaf-format-coflat` topic can mark a repo
// as a Cosheaf/Coflat workspace, but there is no selectable Markdown mode.
const FORMAT_TOPIC_PREFIX = "cosheaf-format-";

export function documentFormatFromTopics(topics: readonly string[]): DocumentFormatId {
  void topics;
  return COFLAT_FORMAT_ID;
}

export function isFormatTopic(topic: string): boolean {
  return topic.startsWith(FORMAT_TOPIC_PREFIX);
}
