import { useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import type { LineComment } from "../api";

const muted = "text-[var(--cf-muted)]";

export interface CommentActions {
  currentForgejoUsername?: string;
  onEdit?: (commentId: number, body: string) => void | Promise<void>;
  onDelete?: (commentId: number, reviewId: number) => void | Promise<void>;
}

export function CommentThread({
  comments,
  currentForgejoUsername,
  onEdit,
  onDelete,
}: { comments: readonly LineComment[] } & CommentActions): ReactElement | null {
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
        <CommentRow
          key={c.id}
          comment={c}
          showSeparator={i > 0}
          isOwn={!!currentForgejoUsername && c.author_username === currentForgejoUsername}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function CommentRow({
  comment,
  showSeparator,
  isOwn,
  onEdit,
  onDelete,
}: {
  comment: LineComment;
  showSeparator: boolean;
  isOwn: boolean;
  onEdit?: (id: number, body: string) => void | Promise<void>;
  onDelete?: (id: number, reviewId: number) => void | Promise<void>;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);

  return (
    <div className={cn("p-2", showSeparator && "border-t border-[var(--cf-border)]")}>
      <div className={cn("flex items-center gap-2 mb-1 text-xs", muted)}>
        <strong className="text-[var(--cf-fg)]">@{comment.author_username}</strong>
        <span>{formatRelative(comment.created_at)}</span>
        {comment.outdated && (
          <span className="px-1 rounded bg-yellow-500/20 text-yellow-700 text-[10px]">outdated</span>
        )}
        {isOwn && !editing && (onEdit || onDelete) && (
          <span className="ml-auto flex gap-2">
            {onEdit && (
              <button
                type="button"
                data-testid={`comment-edit-${comment.id}`}
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
                className="hover:underline"
              >
                edit
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                data-testid={`comment-delete-${comment.id}`}
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm("Delete this comment?")) return;
                  setBusy(true);
                  try {
                    await onDelete(comment.id, comment.review_id);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="hover:underline text-red-600"
              >
                delete
              </button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          <textarea
            data-testid={`comment-edit-body-${comment.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            disabled={busy}
            className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)]"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid={`comment-edit-save-${comment.id}`}
              disabled={busy || draft.trim().length === 0 || draft === comment.body}
              onClick={async () => {
                if (!onEdit) return;
                setBusy(true);
                try {
                  await onEdit(comment.id, draft.trim());
                  setEditing(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words">{comment.body}</div>
      )}
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
