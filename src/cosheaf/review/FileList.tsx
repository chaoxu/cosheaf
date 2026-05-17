import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import type { LineComment, PrFile } from "../api";

const muted = "text-[var(--cf-muted)]";

export function FileList({
  files,
  selectedPath,
  onSelect,
  comments,
}: {
  files: readonly PrFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  comments?: readonly LineComment[];
}): ReactElement {
  const countsByPath = new Map<string, number>();
  for (const c of comments ?? []) {
    if (c.outdated) continue;
    countsByPath.set(c.path, (countsByPath.get(c.path) ?? 0) + 1);
  }
  if (files.length === 0) {
    return <div className={cn("px-3 py-4 text-xs", muted)}>No files changed.</div>;
  }
  return (
    <ul className="flex flex-col gap-px" data-testid="pr-file-list">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            data-testid={`pr-file-${f.path}`}
            onClick={() => onSelect(f.path)}
            className={cn(
              "w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--cf-hover)]",
              selectedPath === f.path && "bg-[var(--cf-hover)]",
            )}
          >
            <StatusGlyph status={f.status} />
            <span className="flex-1 truncate" title={f.previous_path ? `${f.previous_path} → ${f.path}` : f.path}>
              {f.previous_path ? (
                <>
                  <span className={muted}>{f.previous_path}</span> → {f.path}
                </>
              ) : (
                f.path
              )}
            </span>
            {countsByPath.get(f.path) ? (
              <span
                className="text-[10px] px-1 rounded bg-[var(--cf-accent)] text-[var(--cf-accent-fg)]"
                title={`${countsByPath.get(f.path)} comment(s)`}
              >
                💬{countsByPath.get(f.path)}
              </span>
            ) : null}
            <span className={cn("text-xs tabular-nums", muted)}>
              <span className="text-green-600">+{f.additions}</span>{" "}
              <span className="text-red-600">−{f.deletions}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function StatusGlyph({ status }: { status: PrFile["status"] }): ReactElement {
  const map: Record<PrFile["status"], { glyph: string; color: string; label: string }> = {
    added: { glyph: "A", color: "text-green-600", label: "added" },
    modified: { glyph: "M", color: "text-yellow-600", label: "modified" },
    deleted: { glyph: "D", color: "text-red-600", label: "deleted" },
    renamed: { glyph: "R", color: "text-blue-600", label: "renamed" },
    copied: { glyph: "C", color: "text-blue-600", label: "copied" },
  };
  const e = map[status];
  return (
    <span
      title={e.label}
      className={cn("inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold border rounded", e.color)}
    >
      {e.glyph}
    </span>
  );
}
