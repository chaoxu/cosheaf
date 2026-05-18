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

// Format-storage convention: a workspace's markdown format lives in a
// Forgejo repo topic. The presence of `cosheaf-format-<id>` selects that
// format; without it, the default applies.
const FORMAT_TOPIC_PREFIX = "cosheaf-format-";

export function topicForDocumentFormat(id: DocumentFormatId): string {
  return `${FORMAT_TOPIC_PREFIX}${id}`;
}

export function documentFormatFromTopics(topics: readonly string[]): DocumentFormatId {
  for (const t of topics) {
    if (typeof t !== "string" || !t.startsWith(FORMAT_TOPIC_PREFIX)) continue;
    const candidate = t.slice(FORMAT_TOPIC_PREFIX.length);
    if (isDocumentFormatId(candidate)) return candidate;
  }
  return DEFAULT_DOCUMENT_FORMAT_ID;
}

export function isFormatTopic(topic: string): boolean {
  return topic.startsWith(FORMAT_TOPIC_PREFIX);
}
