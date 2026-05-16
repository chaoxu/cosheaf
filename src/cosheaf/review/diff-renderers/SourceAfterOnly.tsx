// Source + After-only view: render the whole head file with added lines
// tinted. Synthesizes a "context + adds" unified patch and feeds it to the
// shared SourceDiff renderer — same library, same look as Source + Unified.

import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { diffLineNumbers } from "../diff-lines";
import { useFileSide } from "../use-file-side";
import { SourceDiff, synthesizeFullFilePatch } from "./SourceDiff";
import type { DiffRendererProps } from "../diff-renderer-types";

const muted = "text-[var(--cf-muted)]";

export function SourceAfterOnly(props: DiffRendererProps): ReactElement {
  const { content, error } = useFileSide(
    props.loadContent,
    "head",
    props.file.status !== "deleted",
    props.file.path,
  );
  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;
  if (props.file.status === "deleted") {
    return <div className={cn("p-3 text-sm", muted)}>(file deleted)</div>;
  }
  if (content === null) return <div className={cn("p-3 text-sm", muted)}>Loading…</div>;

  const added = new Set(diffLineNumbers(props.file.patch, "added"));
  const patch = synthesizeFullFilePatch(content, added);
  return <SourceDiff {...props} viewType="unified" testId="diff-pane-after" patchOverride={patch} />;
}
