import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import type { PrMeta } from "../api";
import type { DocumentFormatId } from "../../../shared/document-format";
import { IssueBodyRender } from "./IssueBodyRender";
import type { DocumentContext } from "../document-format/coflat-context";

const muted = "text-[var(--cf-muted)]";

export function PrHeader({
  pr,
  workspaceSlug,
  formatId,
  documentContext,
}: {
  pr: PrMeta;
  workspaceSlug: string;
  formatId: DocumentFormatId;
  documentContext?: DocumentContext;
}): ReactElement {
  return (
    <header
      data-testid="pr-header"
      className="flex flex-col gap-1 px-4 py-3 border-b border-[var(--cf-border)]"
    >
      <div className="flex items-baseline gap-2">
        <Badge variant={badgeVariant(pr.state, pr.merged)}>{pr.merged ? "merged" : pr.state}</Badge>
        <h2 className="text-base font-semibold leading-tight flex-1 truncate" title={pr.title}>
          {pr.title}
        </h2>
        <span className={cn("text-xs", muted)} data-testid="pr-header-link">#{pr.number}</span>
      </div>
      <div className={cn("flex items-center gap-3 text-xs", muted)}>
        <span>by @{pr.author_username}</span>
        <span>·</span>
        <span>
          <span className="text-green-600">+{pr.additions_total}</span>{" "}
          <span className="text-red-600">−{pr.deletions_total}</span>
          {" "}across {pr.files_changed} {pr.files_changed === 1 ? "file" : "files"}
        </span>
      </div>
      {pr.body.trim().length > 0 && (
        <div className="text-sm">
          <IssueBodyRender
            text={pr.body}
            workspaceSlug={workspaceSlug}
            formatId={formatId}
            ctx={documentContext}
          />
        </div>
      )}
    </header>
  );
}

function badgeVariant(state: PrMeta["state"], merged: boolean): "golden" | "rejected" | "outline" {
  if (merged) return "golden";
  if (state === "closed") return "rejected";
  return "outline";
}
