import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import type { LineComment, PullFile } from "../api";
import type { SpikeId, SpikeProps } from "./spike-types";
import { UnifiedSourceDiff } from "./spikes/UnifiedSourceDiff";
import { HeadWithTint } from "./spikes/HeadWithTint";
import { SideBySideRendered } from "./spikes/SideBySideRendered";
import { LibraryUnified } from "./spikes/LibraryUnified";

const SPIKES: Array<{ id: SpikeId; label: string }> = [
  { id: "unified", label: "Unified" },
  { id: "tint", label: "Source tint" },
  { id: "split", label: "Side-by-side" },
  { id: "rendered", label: "Rendered" },
  { id: "library", label: "Library" },
];

const muted = "text-[var(--cf-muted)]";

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
  const storageKey = `cosheaf:diff-spike:${workspaceSlug}`;
  const [spike, setSpike] = useState<SpikeId>(() => readSpike(storageKey));

  useEffect(() => {
    localStorage.setItem(storageKey, spike);
  }, [spike, storageKey]);

  if (!file) {
    return (
      <div className={cn("flex items-center justify-center h-full text-sm", muted)}>
        Select a file to view its diff.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--cf-border)]">
        <span className={cn("text-xs mr-2", muted)}>View:</span>
        {SPIKES.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`spike-${s.id}`}
            onClick={() => setSpike(s.id)}
            className={cn(
              "px-2 py-1 text-xs rounded hover:bg-[var(--cf-hover)]",
              spike === s.id && "bg-[var(--cf-hover)] font-medium",
            )}
          >
            {s.label}
          </button>
        ))}
        <span className={cn("ml-auto text-xs", muted)}>{file.path}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {renderSpike(spike, {
          file,
          loadContent: (side) => loadContent(file.path, side),
          comments: fileComments,
          currentForgejoUsername,
          onAddComment,
          onEditComment,
          onDeleteComment,
        })}
      </div>
    </div>
  );
}

function renderSpike(id: SpikeId, props: SpikeProps): ReactElement {
  if (id === "unified") return <UnifiedSourceDiff {...props} />;
  if (id === "tint") return <HeadWithTint {...props} mode="source" testId="spike-tint-pane" />;
  if (id === "split") return <SideBySideRendered {...props} />;
  if (id === "library") return <LibraryUnified {...props} />;
  return <HeadWithTint {...props} mode="rich" testId="spike-rendered-pane" />;
}

function readSpike(key: string): SpikeId {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  if (
    v === "unified" ||
    v === "tint" ||
    v === "split" ||
    v === "rendered" ||
    v === "library"
  ) {
    return v;
  }
  return "unified";
}
