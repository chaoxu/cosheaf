import { useMemo } from "react";
import type { ReactElement } from "react";
import type { StandaloneEditorMode } from "@chaoxu/coflat-editor";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { diffLineNumbers } from "../diff-lines";
import { lineTintExtension } from "../cm-line-tint";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

// Renders the head version of the file in the requested coflat mode, with the
// added (new-side) lines highlighted via a CodeMirror extension. Used by both
// the source-tint and rendered-with-highlights spikes.
export function HeadWithTint({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
  mode,
  testId,
}: SpikeProps & { mode: StandaloneEditorMode; testId: string }): ReactElement {
  const { content, error } = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const extensions = useMemo(
    () => [
      ...lineTintExtension(diffLineNumbers(file.patch, "added")),
      commentThreadExtension(comments, "new", {
        currentForgejoUsername,
        onEdit: onEditComment,
        onDelete: onDeleteComment,
      }),
    ],
    [file.patch, comments, currentForgejoUsername, onEditComment, onDeleteComment],
  );

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;
  if (file.status === "deleted") return <div className={cn("p-3 text-sm", muted)}>(file deleted)</div>;
  if (content === null) return <div className={cn("p-3 text-sm", muted)}>Loading…</div>;
  return (
    <div data-testid={testId} className="h-full min-h-0 flex flex-col">
      <MarkdownEditor
        key={`${mode}-${file.path}`}
        value={content}
        mode={mode}
        onChange={() => undefined}
        readOnly
        extensions={extensions}
      />
    </div>
  );
}
