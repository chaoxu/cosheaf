// Rich "Side-by-side" view: base and head rendered through coflat-editor.
// Reader sees both versions of the page as they will appear, side by side.
// Source mode for split is handled separately (SourceDiff in `viewType="split"`),
// not via this component. This file is rich-only.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import type { LineComment } from "../../api";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: SpikeProps): ReactElement {
  const base = useFileSide(loadContent, "base", file.status !== "added", file.path);
  const head = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const error = base.error ?? head.error;

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  const shared = {
    file,
    comments,
    currentForgejoUsername,
    onEditComment,
    onDeleteComment,
  };

  return (
    <div
      data-testid="diff-pane-split"
      // Zero out coflat's sidenote gutter so each pane's rich content fills
      // its column width.
      style={{ ["--cf-sidenote-width" as never]: "0px", ["--cf-content-max-width" as never]: "none" }}
      className="grid grid-cols-2 divide-x divide-[var(--cf-border)]"
    >
      <Pane
        {...shared}
        label="base"
        side="old"
        content={base.content}
        emptyLabel={file.status === "added" ? "(new file)" : null}
      />
      <Pane
        {...shared}
        label="head"
        side="new"
        content={head.content}
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
  file,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: {
  label: "base" | "head";
  content: string | null;
  emptyLabel: string | null;
  comments: readonly LineComment[];
  side: "new" | "old";
  file: SpikeProps["file"];
  currentForgejoUsername?: string;
  onEditComment?: SpikeProps["onEditComment"];
  onDeleteComment?: SpikeProps["onDeleteComment"];
}): ReactElement {
  const extensions = useMemo(
    () => [
      commentThreadExtension(comments, side, {
        currentForgejoUsername,
        onEdit: onEditComment,
        onDelete: onDeleteComment,
      }),
    ],
    [comments, side, currentForgejoUsername, onEditComment, onDeleteComment],
  );

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
          <MarkdownEditor
            key={`${label}-rich-${file.path}`}
            value={content}
            mode="rich"
            onChange={() => undefined}
            readOnly
            extensions={extensions}
          />
        )}
      </div>
    </div>
  );
}
