import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import type { LineComment } from "../api";

const muted = "text-[var(--cf-muted)]";

export function CommentThread({ comments }: { comments: readonly LineComment[] }): ReactElement | null {
  if (comments.length === 0) return null;
  const outdated = comments.every((c) => c.outdated);
  return (
    <div
      data-testid="comment-thread"
      className={cn(
        "border-l-2 border-[var(--cf-accent)] bg-[var(--cf-hover)] mx-2 my-1 rounded text-[13px]",
        outdated && "opacity-60",
      )}
    >
      {comments.map((c, i) => (
        <div
          key={c.id}
          className={cn("p-2", i > 0 && "border-t border-[var(--cf-border)]")}
        >
          <div className={cn("flex items-center gap-2 mb-1 text-xs", muted)}>
            <strong className="text-[var(--cf-fg)]">@{c.author_username}</strong>
            <span>{formatRelative(c.created_at)}</span>
            {c.outdated && <span className="px-1 rounded bg-yellow-500/20 text-yellow-700 text-[10px]">outdated</span>}
          </div>
          <div className="whitespace-pre-wrap break-words">{c.body}</div>
        </div>
      ))}
    </div>
  );
}

function formatRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
