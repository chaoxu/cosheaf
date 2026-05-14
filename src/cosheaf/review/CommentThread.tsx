import { useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited = comment.updated_at > comment.created_at + 1000; // 1s slack
  const canSave = draft.trim().length > 0 && draft !== comment.body;

  async function save() {
    if (!onEdit || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onEdit(comment.id, draft.trim());
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!onDelete) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(comment.id, comment.review_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false); // only reset on error — successful delete unmounts the row
    }
  }

  function onTextareaKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      setDraft(comment.body);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  return (
    <div className={cn("p-2", showSeparator && "border-t border-[var(--cf-border)]")}>
      <div className={cn("flex items-center gap-2 mb-1 text-xs", muted)}>
        <strong className="text-[var(--cf-fg)]">@{comment.author_username}</strong>
        <span>{formatRelative(comment.created_at)}</span>
        {edited && <span className="text-[10px]">(edited)</span>}
        {comment.outdated && (
          <span className="px-1 rounded bg-yellow-500/20 text-yellow-700 text-[10px]">outdated</span>
        )}
        {isOwn && !editing && !confirmDelete && (onEdit || onDelete) && (
          <span className="ml-auto flex gap-2">
            {onEdit && (
              <button
                type="button"
                data-testid={`comment-edit-${comment.id}`}
                onClick={() => {
                  setDraft(comment.body);
                  setError(null);
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
                onClick={() => setConfirmDelete(true)}
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
            autoFocus
            data-testid={`comment-edit-body-${comment.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onTextareaKey}
            rows={2}
            disabled={busy}
            className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)]"
          />
          <div className="flex items-center gap-2 justify-end">
            <span className={cn("text-[10px] mr-auto", muted)}>Esc to cancel · ⌘↵ to save</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid={`comment-edit-save-${comment.id}`}
              disabled={busy || !canSave}
              onClick={save}
            >
              Save
            </Button>
          </div>
        </div>
      ) : confirmDelete ? (
        <div className="flex items-center gap-2 p-1">
          <span className="text-xs">Delete this comment?</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            data-testid={`comment-delete-confirm-${comment.id}`}
            disabled={busy}
            onClick={remove}
          >
            Delete
          </Button>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words">{comment.body}</div>
      )}
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
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
