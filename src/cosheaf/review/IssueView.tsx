// Issue detail surface: title, markdown body, threaded comments,
// close/reopen, new-comment composer.

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { api } from "../api";
import type { IssueComment, IssueDetail } from "../api";

const muted = "text-[var(--cf-muted)]";

export function IssueView({
  workspaceSlug,
  number,
  currentForgejoUsername,
  onClose,
}: {
  workspaceSlug: string;
  number: number;
  currentForgejoUsername?: string;
  onClose: () => void;
}): ReactElement {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = async () => {
    try {
      const [det, cms] = await Promise.all([
        api.getIssue(workspaceSlug, number),
        api.getIssueComments(workspaceSlug, number),
      ]);
      setIssue(det);
      setComments(cms.comments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load issue");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, number]);

  async function submitComment() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await api.createIssueComment(workspaceSlug, number, draft.trim());
      setDraft("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to comment");
    } finally {
      setBusy(false);
    }
  }

  async function toggleState() {
    if (!issue || busy) return;
    setBusy(true);
    try {
      if (issue.state === "open") await api.closeIssue(workspaceSlug, number);
      else await api.reopenIssue(workspaceSlug, number);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!issue) {
    return (
      <div className={cn("p-4 text-sm", muted)} data-testid="issue-view">
        {error ? `Failed: ${error}` : "Loading…"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="issue-view">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-[var(--cf-border)]">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className={cn(
              "px-1.5 py-0.5 rounded uppercase tracking-wide",
              issue.state === "open" ? "bg-green-500/15 text-green-700" : "bg-purple-500/15 text-purple-700",
            )}>
              {issue.state}
            </span>
            <span className={muted}>ISSUE</span>
            <span className={muted}>·</span>
            <span>by @{issue.author}</span>
            <span className={cn("ml-auto", muted)}>#{issue.number}</span>
          </div>
          <h1 className="text-lg font-semibold truncate">{issue.title}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={toggleState} disabled={busy} data-testid="issue-toggle-state">
            {issue.state === "open" ? "Close issue" : "Reopen"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="issue-exit">
            Close view
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-4">
        <div className="rounded border border-[var(--cf-border)] p-3">
          <div className={cn("text-xs mb-2", muted)}>
            <strong className="text-[var(--cf-fg)]">@{issue.author}</strong> opened this issue
          </div>
          <div className="whitespace-pre-wrap break-words text-sm">{issue.body || <em className={muted}>(no description)</em>}</div>
        </div>
        {comments.map((c) => {
          const isOwn = !!currentForgejoUsername && c.author === currentForgejoUsername;
          const editing = editingId === c.id;
          return (
            <div
              key={c.id}
              className="rounded border border-[var(--cf-border)] p-3"
              data-testid={`issue-comment-${c.id}`}
            >
              <div className={cn("flex items-center gap-2 text-xs mb-2", muted)}>
                <strong className="text-[var(--cf-fg)]">@{c.author}</strong>
                <span>{formatRel(c.created_at)}</span>
                {c.updated_at > c.created_at + 1000 && <span>(edited)</span>}
                {isOwn && !editing && (
                  <span className="ml-auto flex gap-2">
                    <button
                      type="button"
                      data-testid={`issue-comment-edit-${c.id}`}
                      onClick={() => { setEditingId(c.id); setEditDraft(c.body); }}
                      className="hover:underline"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      data-testid={`issue-comment-delete-${c.id}`}
                      onClick={async () => {
                        if (!window.confirm("Delete this comment?")) return;
                        await api.deleteIssueComment(workspaceSlug, number, c.id);
                        await refresh();
                      }}
                      className="hover:underline text-red-600"
                    >
                      delete
                    </button>
                  </span>
                )}
              </div>
              {editing ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button
                      size="sm"
                      data-testid={`issue-comment-save-${c.id}`}
                      disabled={busy || editDraft.trim().length === 0 || editDraft === c.body}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api.editIssueComment(workspaceSlug, number, c.id, editDraft.trim());
                          setEditingId(null);
                          await refresh();
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
                <div className="whitespace-pre-wrap break-words text-sm">{c.body}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-[var(--cf-border)] p-3 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={3}
          data-testid="issue-new-comment"
          className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            data-testid="issue-new-comment-submit"
            disabled={busy || draft.trim().length === 0}
            onClick={submitComment}
          >
            Comment
          </Button>
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </div>
  );
}

function formatRel(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
