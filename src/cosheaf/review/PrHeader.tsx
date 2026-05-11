import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import type { PrMeta } from "../api";

const muted = "text-[var(--cf-muted)]";

export function PrHeader({
  pr,
  forgejoRepoUrl,
}: {
  pr: PrMeta;
  forgejoRepoUrl?: string;
}): ReactElement {
  const link = forgejoRepoUrl ? `${forgejoRepoUrl}/pulls/${pr.number}` : null;
  return (
    <header
      data-testid="pr-header"
      className="flex flex-col gap-1 px-4 py-3 border-b border-[var(--cf-border)]"
    >
      <div className="flex items-baseline gap-2">
        <Badge variant={badgeVariant(pr.state)}>{pr.state}</Badge>
        <h2 className="text-base font-semibold leading-tight flex-1 truncate" title={pr.title}>
          {pr.title}
        </h2>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className={cn("text-xs hover:underline", muted)}
            data-testid="pr-header-link"
          >
            #{pr.number} ↗
          </a>
        ) : (
          <span className={cn("text-xs", muted)}>#{pr.number}</span>
        )}
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
    </header>
  );
}

function badgeVariant(state: PrMeta["state"]): "golden" | "rejected" | "outline" {
  if (state === "merged") return "golden";
  if (state === "closed" || state === "changes_requested") return "rejected";
  return "outline";
}
