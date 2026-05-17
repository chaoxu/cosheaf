import { useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Decision, PrState, Role } from "../api";

const muted = "text-[var(--cf-muted)]";

export function ReviewActions({
  state,
  merged,
  role,
  isAuthor,
  onSubmit,
  onClose,
  busy,
  pendingReviewActive,
  onTogglePendingReview,
}: {
  state: PrState;
  merged: boolean;
  role: Role;
  isAuthor: boolean;
  onSubmit: (decision: Decision, body: string) => void | Promise<void>;
  onClose: () => void | Promise<void>;
  busy?: boolean;
  pendingReviewActive?: boolean;
  onTogglePendingReview?: () => void | Promise<void>;
}): ReactElement | null {
  const [body, setBody] = useState("");
  const isTerminal = merged || state === "closed";
  const canDecide = role !== "read" && !isAuthor && !isTerminal;
  const canCloseAsAuthor = isAuthor && !isTerminal;
  const canCloseAsAdmin = role === "admin" && !isTerminal;
  const canClose = canCloseAsAuthor || canCloseAsAdmin;

  if (isTerminal) {
    return (
      <footer
        data-testid="review-actions"
        className="flex items-center gap-2 px-4 py-3 border-t border-[var(--cf-border)]"
      >
        <span className={cn("text-sm", muted)}>
          {merged ? "Merged — no further actions." : "Closed."}
        </span>
      </footer>
    );
  }

  return (
    <footer
      data-testid="review-actions"
      className="flex flex-col gap-2 px-4 py-3 border-t border-[var(--cf-border)]"
    >
      <textarea
        data-testid="review-comment"
        placeholder={
          canDecide
            ? "Leave a comment with your review… (optional)"
            : isAuthor
              ? "You can't review your own change."
              : "Members can't review."
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={!canDecide || busy}
        rows={2}
        className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)] disabled:opacity-60"
      />
      <div className="flex items-center gap-2">
        {onTogglePendingReview && canDecide && (
          <Button
            data-testid="review-toggle-pending"
            variant={pendingReviewActive ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={onTogglePendingReview}
            title={
              pendingReviewActive
                ? "Comments are batched into a pending review; submit with Approve/Request changes/Comment."
                : "Batch line comments before submitting one review."
            }
          >
            {pendingReviewActive ? "Pending review active" : "Start a review"}
          </Button>
        )}
        <Button
          data-testid="review-comment-submit"
          variant="outline"
          size="sm"
          disabled={!canDecide || busy || (body.trim().length === 0 && !pendingReviewActive)}
          onClick={async () => {
            await onSubmit("comment", body);
            setBody("");
          }}
        >
          Comment
        </Button>
        <Button
          data-testid="review-request-changes"
          variant="outline"
          size="sm"
          disabled={!canDecide || busy}
          onClick={async () => {
            await onSubmit("request_changes", body);
            setBody("");
          }}
        >
          Request changes
        </Button>
        <Button
          data-testid="review-approve"
          size="sm"
          disabled={!canDecide || busy}
          onClick={async () => {
            await onSubmit("approve", body);
            setBody("");
          }}
        >
          Approve
        </Button>
        {canClose && (
          <Button
            data-testid="review-close"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onClose}
            className="ml-auto"
          >
            Close PR
          </Button>
        )}
      </div>
    </footer>
  );
}
