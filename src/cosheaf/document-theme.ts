export type DocumentThemeId = "default" | "blueprint-book";
type ViewMode = "source" | "rich";

const LEGACY_DOCUMENT_THEME_KEY = "cosheaf:document-theme";
const LEGACY_EDITOR_MODE_KEY = "cosheaf:editor-mode";
const LEGACY_AUTOSAVE_KEY = "cosheaf:autosave";
const LEGACY_SECTION_NUMBERING_KEY = "cosheaf:section-numbering";

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

export function normalizeDiffMode(value: string | null | undefined): ViewMode {
  return value === "source" ? "source" : "rich";
}

// Preferred compose mode the page + comment editors open in (#155). An
// in-editor toggle still overrides per-session. Default: rich.
export function editorModeStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_EDITOR_MODE_KEY}:${clean}` : LEGACY_EDITOR_MODE_KEY;
}

export function readEditorMode(username?: string | null): ViewMode {
  if (typeof localStorage === "undefined") return "rich";
  return normalizeDiffMode(
    localStorage.getItem(editorModeStorageKey(username)) ?? localStorage.getItem(LEGACY_EDITOR_MODE_KEY),
  );
}

export function writeEditorMode(mode: ViewMode, username?: string | null): void {
  if (typeof localStorage === "undefined") return;
  const normalized = normalizeDiffMode(mode);
  localStorage.setItem(editorModeStorageKey(username), normalized);
  localStorage.setItem(LEGACY_EDITOR_MODE_KEY, normalized);
}

// Autosave preference (#158): the editor autosaves the in-progress source to a
// local draft (#162) on this interval; "off" disables drafting (manual save
// only). Stored as "off" or one of the allowed interval strings.
export interface AutosavePreference {
  enabled: boolean;
  intervalMs: number;
}
export const AUTOSAVE_INTERVALS = [1000, 1500, 3000, 5000] as const;
const DEFAULT_AUTOSAVE_MS = 1500;

export function autosaveStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_AUTOSAVE_KEY}:${clean}` : LEGACY_AUTOSAVE_KEY;
}

export function normalizeAutosave(value: string | null | undefined): string {
  if (value === "off") return "off";
  const n = Number(value);
  return (AUTOSAVE_INTERVALS as readonly number[]).includes(n) ? String(n) : String(DEFAULT_AUTOSAVE_MS);
}

export function readAutosave(username?: string | null): AutosavePreference {
  if (typeof localStorage === "undefined") return { enabled: true, intervalMs: DEFAULT_AUTOSAVE_MS };
  const value = normalizeAutosave(
    localStorage.getItem(autosaveStorageKey(username)) ?? localStorage.getItem(LEGACY_AUTOSAVE_KEY),
  );
  return value === "off" ? { enabled: false, intervalMs: DEFAULT_AUTOSAVE_MS } : { enabled: true, intervalMs: Number(value) };
}

// Reader section-numbering preference (#159). When off, the reader passes
// sectionNumbering:false to Coflat (coflat#47), hiding heading numbers across
// the reader, thread bodies, and rich diff. Default: on.
export function sectionNumberingStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_SECTION_NUMBERING_KEY}:${clean}` : LEGACY_SECTION_NUMBERING_KEY;
}

export function readSectionNumbering(username?: string | null): boolean {
  if (typeof localStorage === "undefined") return true;
  const value = localStorage.getItem(sectionNumberingStorageKey(username)) ?? localStorage.getItem(LEGACY_SECTION_NUMBERING_KEY);
  return value !== "off";
}
