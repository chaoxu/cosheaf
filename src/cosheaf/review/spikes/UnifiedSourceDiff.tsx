import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function UnifiedSourceDiff({ file }: SpikeProps): ReactElement {
  if (!file.patch) {
    return <div className={cn("p-3 text-sm", muted)}>(no textual diff — binary or empty)</div>;
  }
  const rows = renderRows(file.patch);
  return (
    <div data-testid="spike-unified-pane" className="text-[13px] font-mono leading-5">
      {rows.map((r, i) => {
        if (r.kind === "hunk") {
          return (
            <div
              key={i}
              className={cn("px-3 py-1 bg-[var(--cf-hover)] text-xs", muted)}
            >
              {r.text}
            </div>
          );
        }
        const bg =
          r.kind === "add" ? "bg-green-500/10" : r.kind === "del" ? "bg-red-500/10" : "";
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
        const baseGutter = r.baseLine === null ? "" : String(r.baseLine);
        const headGutter = r.headLine === null ? "" : String(r.headLine);
        return (
          <div key={i} className={cn("flex", bg)}>
            <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none", muted)}>
              {baseGutter}
            </span>
            <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none", muted)}>
              {headGutter}
            </span>
            <span className="w-4 select-none text-center">{sign}</span>
            <span className="flex-1 whitespace-pre">{r.text}</span>
          </div>
        );
      })}
    </div>
  );
}

type Row =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; text: string; baseLine: number | null; headLine: number | null };

function renderRows(patch: string): Row[] {
  const out: Row[] = [];
  let baseLine = 0;
  let headLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity index") || raw.startsWith("rename from") || raw.startsWith("rename to") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      baseLine = Number(hunk[1]);
      headLine = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), baseLine: null, headLine });
      headLine++;
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), baseLine, headLine: null });
      baseLine++;
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      out.push({ kind: "ctx", text: content, baseLine, headLine });
      baseLine++;
      headLine++;
    }
  }
  return out;
}
