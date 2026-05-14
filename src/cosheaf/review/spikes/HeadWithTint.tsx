import { useMemo } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { diffLineNumbers } from "../diff-lines";
import { lineTintExtension } from "../cm-line-tint";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

// Rendered spike: the head version of the file in rich mode, with the
// added lines tinted in-line.
export function HeadWithTint({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: SpikeProps): ReactElement {
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
    <div data-testid="spike-rendered-pane" className="h-full min-h-0 flex flex-col">
      <MarkdownEditor
        key={`rendered-${file.path}`}
        value={content}
        mode="rich"
        onChange={() => undefined}
        readOnly
        extensions={extensions}
      />
    </div>
  );
}
