export type DocumentRailMode = "read" | "edit";

export interface DocumentRailControl {
  kind: "link" | "button";
  label: string;
  href?: string;
  active?: boolean;
  modeLink?: boolean;
}

export interface DocumentRailGroup {
  label: string;
  controls: readonly DocumentRailControl[];
}

export interface DocumentRailModel {
  groups: readonly DocumentRailGroup[];
  outline: readonly DocumentRailOutlineItem[];
}

export interface DocumentRailOutlineInput {
  key: string;
  level: number;
  label: string;
  html?: string;
  line?: number;
}

export interface DocumentRailOutlineItem extends DocumentRailOutlineInput {
  className: string;
}

export const DOCUMENT_RAIL_CONTROLS_CLASS = "doc-view-controls";
export const DOCUMENT_RAIL_CONTROLS_LABEL = "View";
export const DOCUMENT_RAIL_GROUP_CLASS = "doc-view-group";
export const DOCUMENT_RAIL_LABEL_CLASS = "doc-view-label";
export const DOCUMENT_RAIL_SWITCH_CLASS = "doc-view-switch";
export const DOCUMENT_RAIL_OUTLINE_CLASS = "doc-rail-outline doc-toc";
export const DOCUMENT_RAIL_OUTLINE_LABEL = "On this page";
export const DOCUMENT_RAIL_OUTLINE_TITLE_CLASS = "doc-toc-title";

export function documentRailModel(opts: {
  mode: DocumentRailMode;
  readHref: string;
  editHref?: string | null;
  fileControls?: readonly DocumentRailControl[];
  editorMode?: "rich" | "source";
  outline: readonly DocumentRailOutlineInput[];
  maxOutlineLevel?: number;
}): DocumentRailModel {
  return {
    groups: documentRailGroups(opts),
    outline: documentRailOutline(opts.outline, { maxLevel: opts.maxOutlineLevel }),
  };
}

export function documentRailGroups(opts: {
  mode: DocumentRailMode;
  readHref: string;
  editHref?: string | null;
  fileControls?: readonly DocumentRailControl[];
  editorMode?: "rich" | "source";
}): readonly DocumentRailGroup[] {
  const groups: DocumentRailGroup[] = [
    {
      label: "Mode",
      controls: [
        { kind: "link", label: "Read", href: opts.readHref, active: opts.mode === "read", modeLink: true },
        ...opts.editHref
          ? [{ kind: "link" as const, label: "Edit", href: opts.editHref, active: opts.mode === "edit", modeLink: true }]
          : [],
      ],
    },
  ];
  if (opts.mode === "edit" && opts.editorMode) {
    groups.push({
      label: "Editor",
      controls: [
        { kind: "button", label: "Rich", active: opts.editorMode !== "source" },
        { kind: "button", label: "Source", active: opts.editorMode === "source" },
      ],
    });
  } else if (opts.fileControls?.length) {
    groups.push({ label: "File", controls: opts.fileControls });
  }
  return groups;
}

export function documentRailOutline(
  outline: readonly DocumentRailOutlineInput[],
  opts: { maxLevel?: number } = {},
): readonly DocumentRailOutlineItem[] {
  const maxLevel = opts.maxLevel ?? 3;
  const items = outline.filter((entry) => Number.isFinite(entry.level) && entry.level <= maxLevel);
  if (!items.length) return [];
  const minLevel = Math.min(...items.map((entry) => entry.level));
  return items.map((entry) => ({
    ...entry,
    className: `doc-toc-link lvl-${Math.max(0, entry.level - minLevel)}`,
  }));
}
