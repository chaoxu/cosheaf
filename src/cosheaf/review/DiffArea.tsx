import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import type { LineComment, PullFile } from "../api";
import type { SpikeProps, ViewMode, ViewShape } from "./spike-types";
import { UnifiedSourceDiff } from "./spikes/UnifiedSourceDiff";
import { HeadWithTint } from "./spikes/HeadWithTint";
import { SideBySideRendered } from "./spikes/SideBySideRendered";

const MODES: Array<{ id: ViewMode; label: string }> = [
  { id: "source", label: "Source" },
  { id: "rich", label: "Rich" },
];

const SHAPES: Array<{ id: ViewShape; label: string }> = [
  { id: "unified", label: "Unified" },
  { id: "split", label: "Side-by-side" },
  { id: "after", label: "After only" },
];

const muted = "text-[var(--cf-muted)]";

// Rich + Unified is the one cell we don't implement — there's no clean way
// to interleave rich-rendered markdown blocks inside react-diff-view's
// tabular hunks.
function isDisabled(mode: ViewMode, shape: ViewShape): boolean {
  return mode === "rich" && shape === "unified";
}

export function DiffArea({
  file,
  workspaceSlug,
  loadContent,
  comments,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  file: PullFile | null;
  workspaceSlug: string;
  loadContent: (path: string, side: "base" | "head") => Promise<string>;
  comments: readonly LineComment[];
  currentForgejoUsername?: string;
  onAddComment?: SpikeProps["onAddComment"];
  onEditComment?: SpikeProps["onEditComment"];
  onDeleteComment?: SpikeProps["onDeleteComment"];
}): ReactElement {
  const fileComments = useMemo(
    () => (file ? comments.filter((c) => c.path === file.path) : []),
    [comments, file],
  );
  const modeKey = `cosheaf:diff-mode:${workspaceSlug}`;
  const shapeKey = `cosheaf:diff-shape:${workspaceSlug}`;
  const [mode, setMode] = useState<ViewMode>(() => readMode(modeKey));
  const [shape, setShape] = useState<ViewShape>(() => readShape(shapeKey));

  // If the active combination became invalid (e.g. user switched mode and
  // landed on Rich+Unified), nudge the shape to a valid one.
  useEffect(() => {
    if (isDisabled(mode, shape)) setShape("split");
  }, [mode, shape]);

  useEffect(() => {
    localStorage.setItem(modeKey, mode);
  }, [mode, modeKey]);
  useEffect(() => {
    localStorage.setItem(shapeKey, shape);
  }, [shape, shapeKey]);

  if (!file) {
    return (
      <div className={cn("flex items-center justify-center h-full text-sm", muted)}>
        Select a file to view its diff.
      </div>
    );
  }

  const spikeProps: SpikeProps = {
    file,
    loadContent: (side) => loadContent(file.path, side),
    comments: fileComments,
    currentForgejoUsername,
    onAddComment,
    onEditComment,
    onDeleteComment,
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--cf-border)]">
        <Toggle label="View" items={MODES} value={mode} onChange={setMode} testIdPrefix="view-mode" />
        <Toggle
          label="Shape"
          items={SHAPES}
          value={shape}
          onChange={setShape}
          testIdPrefix="view-shape"
          disabledItem={(id) => isDisabled(mode, id)}
        />
        <span className={cn("ml-auto text-xs", muted)}>{file.path}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{renderView(mode, shape, spikeProps)}</div>
    </div>
  );
}

function Toggle<T extends string>({
  label,
  items,
  value,
  onChange,
  testIdPrefix,
  disabledItem,
}: {
  label: string;
  items: Array<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  testIdPrefix: string;
  disabledItem?: (id: T) => boolean;
}): ReactElement {
  return (
    <div className="flex items-center gap-1">
      <span className={cn("text-xs mr-1", muted)}>{label}:</span>
      {items.map((it) => {
        const disabled = disabledItem?.(it.id) ?? false;
        return (
          <button
            key={it.id}
            type="button"
            data-testid={`${testIdPrefix}-${it.id}`}
            disabled={disabled}
            onClick={() => onChange(it.id)}
            className={cn(
              "px-2 py-1 text-xs rounded",
              !disabled && "hover:bg-[var(--cf-hover)]",
              value === it.id && "bg-[var(--cf-hover)] font-medium",
              disabled && "opacity-40 cursor-not-allowed",
            )}
            title={disabled ? "Not available in this mode" : undefined}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function renderView(mode: ViewMode, shape: ViewShape, props: SpikeProps): ReactElement {
  if (shape === "unified") return <UnifiedSourceDiff {...props} />;
  if (shape === "split") return <SideBySideRendered {...props} mode={mode} />;
  return <HeadWithTint {...props} mode={mode} />;
}

function readMode(key: string): ViewMode {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return v === "source" || v === "rich" ? v : "source";
}

function readShape(key: string): ViewShape {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return v === "unified" || v === "split" || v === "after" ? v : "unified";
}
