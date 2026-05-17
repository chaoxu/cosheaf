// Rich "Side-by-side" review view: base and head rendered as HTML via the
// coflat reader, side by side. Comment threads attach to source-line anchors;
// CodeMirror is no longer involved on this surface.

import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { RichDiffRender } from "../RichDiffRender";
import { diffLineNumbers } from "../diff-lines";
import { useFileSide } from "../use-file-side";
import type { LineComment } from "../../api";
import type { DiffRendererProps } from "../diff-renderer-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: DiffRendererProps): ReactElement {
  const base = useFileSide(loadContent, "base", file.status !== "added", file.path);
  const head = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const error = base.error ?? head.error;

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  const shared = { file, comments, currentForgejoUsername, onEditComment, onDeleteComment };
  return (
    <div
      data-testid="diff-pane-split"
      style={{ ["--cf-sidenote-width" as never]: "0px", ["--cf-content-max-width" as never]: "none" }}
      className="grid grid-cols-2 divide-x divide-[var(--cf-border)]"
    >
      <Pane
        {...shared}
        label="base"
        side="base"
        content={base.content}
        addedLines={diffLineNumbers(file.patch, "removed")}
        emptyLabel={file.status === "added" ? "(new file)" : null}
      />
      <Pane
        {...shared}
        label="head"
        side="head"
        content={head.content}
        addedLines={diffLineNumbers(file.patch, "added")}
        emptyLabel={file.status === "deleted" ? "(deleted)" : null}
      />
    </div>
  );
}

function Pane({
  label,
  content,
  emptyLabel,
  comments,
  side,
  addedLines,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: {
  label: "base" | "head";
  content: string | null;
  emptyLabel: string | null;
  comments: readonly LineComment[];
  side: "head" | "base";
  addedLines: readonly number[];
  currentForgejoUsername?: string;
  onEditComment?: DiffRendererProps["onEditComment"];
  onDeleteComment?: DiffRendererProps["onDeleteComment"];
  file: DiffRendererProps["file"];
}): ReactElement {
  return (
    <div className="flex flex-col min-h-0">
      <div className={cn("px-3 py-1 text-xs border-b border-[var(--cf-border)]", muted)}>
        {label}
      </div>
      <div className="min-h-0 flex flex-col">
        {emptyLabel ? (
          <div className={cn("p-3 text-sm", muted)}>{emptyLabel}</div>
        ) : content === null ? (
          <div className={cn("p-3 text-sm", muted)}>Loading…</div>
        ) : (
          <RichDiffRender
            source={content}
            addedLines={addedLines}
            comments={comments}
            side={side}
            actions={{ currentForgejoUsername, onEdit: onEditComment, onDelete: onDeleteComment }}
          />
        )}
      </div>
    </div>
  );
}
