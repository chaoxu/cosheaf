import { blueprintBookThemeManifest } from "@chaoxu/coflat-editor/reader";

export type DocumentThemeId = "default" | "blueprint-book";

const LEGACY_DOCUMENT_THEME_KEY = "cosheaf:document-theme";

export const DOCUMENT_THEMES: Array<{ id: DocumentThemeId; label: string }> = [
  { id: "default", label: "Default" },
  { id: blueprintBookThemeManifest.id as DocumentThemeId, label: blueprintBookThemeManifest.name },
];

export function normalizeDocumentTheme(value: string | null | undefined): DocumentThemeId {
  return value === "blueprint-book" ? value : "default";
}

export function documentThemeStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_DOCUMENT_THEME_KEY}:${clean}` : LEGACY_DOCUMENT_THEME_KEY;
}

export function readDocumentTheme(username?: string | null): DocumentThemeId {
  if (typeof localStorage === "undefined") return "default";
  const userValue = localStorage.getItem(documentThemeStorageKey(username));
  if (userValue) return normalizeDocumentTheme(userValue);
  return normalizeDocumentTheme(localStorage.getItem(LEGACY_DOCUMENT_THEME_KEY));
}

export function writeDocumentTheme(theme: DocumentThemeId, username?: string | null): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(documentThemeStorageKey(username), theme);
  localStorage.setItem(LEGACY_DOCUMENT_THEME_KEY, theme);
}
