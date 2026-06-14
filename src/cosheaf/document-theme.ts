import { blueprintBookThemeManifest } from "@chaoxu/coflat/reader";

export type DocumentThemeId = "default" | "blueprint-book";
export type ViewMode = "source" | "rich";
export type ViewShape = "unified" | "split" | "after";

const LEGACY_DOCUMENT_THEME_KEY = "cosheaf:document-theme";
const LEGACY_DIFF_MODE_KEY = "cosheaf:diff-mode";
const LEGACY_DIFF_SHAPE_KEY = "cosheaf:diff-shape";
const LEGACY_EDITOR_MODE_KEY = "cosheaf:editor-mode";
const LEGACY_AUTOSAVE_KEY = "cosheaf:autosave";
const LEGACY_SECTION_NUMBERING_KEY = "cosheaf:section-numbering";

export interface DiffViewPreference {
  mode: ViewMode;
  shape: ViewShape;
}

export const DOCUMENT_THEMES: Array<{ id: DocumentThemeId; label: string }> = [
  { id: "default", label: "Default" },
  { id: blueprintBookThemeManifest.id as DocumentThemeId, label: blueprintBookThemeManifest.name },
];

export const DIFF_VIEW_MODES: Array<{ id: ViewMode; label: string }> = [
  { id: "source", label: "Source" },
  { id: "rich", label: "Rich" },
];

export const DIFF_VIEW_SHAPES: Array<{ id: ViewShape; label: string }> = [
  { id: "unified", label: "Unified" },
  { id: "split", label: "Side-by-side" },
  { id: "after", label: "After only" },
];

export const DEFAULT_DIFF_VIEW_PREFERENCE: DiffViewPreference = {
  mode: "rich",
  shape: "after",
};

export function normalizeDocumentTheme(value: string | null | undefined): DocumentThemeId {
  return value === "blueprint-book" ? value : "default";
}

export function documentThemeStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_DOCUMENT_THEME_KEY}:${clean}` : LEGACY_DOCUMENT_THEME_KEY;
}

export function diffModeStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_DIFF_MODE_KEY}:${clean}` : LEGACY_DIFF_MODE_KEY;
}

export function diffShapeStorageKey(username: string | null | undefined): string {
  const clean = username?.trim();
  return clean ? `${LEGACY_DIFF_SHAPE_KEY}:${clean}` : LEGACY_DIFF_SHAPE_KEY;
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

export function normalizeDiffMode(value: string | null | undefined): ViewMode {
  return value === "source" ? "source" : "rich";
}

export function normalizeDiffShape(value: string | null | undefined, mode: ViewMode): ViewShape {
  const shape = value === "unified" || value === "split" || value === "after" ? value : "after";
  return mode === "rich" && shape === "unified" ? "after" : shape;
}

export function readDiffViewPreference(username?: string | null): DiffViewPreference {
  if (typeof localStorage === "undefined") return DEFAULT_DIFF_VIEW_PREFERENCE;
  const mode = normalizeDiffMode(
    localStorage.getItem(diffModeStorageKey(username)) ?? localStorage.getItem(LEGACY_DIFF_MODE_KEY),
  );
  const shape = normalizeDiffShape(
    localStorage.getItem(diffShapeStorageKey(username)) ?? localStorage.getItem(LEGACY_DIFF_SHAPE_KEY),
    mode,
  );
  return { mode, shape };
}

export function writeDiffViewPreference(preference: DiffViewPreference, username?: string | null): void {
  if (typeof localStorage === "undefined") return;
  const mode = normalizeDiffMode(preference.mode);
  const shape = normalizeDiffShape(preference.shape, mode);
  localStorage.setItem(diffModeStorageKey(username), mode);
  localStorage.setItem(diffShapeStorageKey(username), shape);
  localStorage.setItem(LEGACY_DIFF_MODE_KEY, mode);
  localStorage.setItem(LEGACY_DIFF_SHAPE_KEY, shape);
}

// Preferred compose mode the page + comment editors open in (#155). Shares the
// ViewMode "rich"/"source" shape and normalizer with the diff preference; an
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
