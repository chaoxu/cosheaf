import { useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { ChangeState, Decision, Role } from "../api";

const muted = "text-[var(--cf-muted)]";

export function ReviewActions({
  state,
  role,
  isAuthor,
  onSubmit,
  onClose,
  busy,
  draftReviewActive,
  onToggleDraftReview,
}: {
  state: ChangeState;
  role: Role;
  isAuthor: boolean;
  onSubmit: (decision: Decision, body: string) => void | Promise<void>;
  onClose: () => void | Promise<void>;
  busy?: boolean;
  draftReviewActive?: boolean;
  onToggleDraftReview?: () => void | Promise<void>;
}): ReactElement | null {
  const [body, setBody] = useState("");

  const canDecide = (role === "owner" || role === "verifier") && !isAuthor;
  const canCloseAsAuthor = isAuthor && state !== "merged" && state !== "closed";
  const canCloseAsOwner = role === "owner" && state !== "merged" && state !== "closed";
  const canClose = canCloseAsAuthor || canCloseAsOwner;

  if (state === "merged" || state === "closed") {
    return (
      <footer
        data-testid="review-actions"
        className="flex items-center gap-2 px-4 py-3 border-t border-[var(--cf-border)]"
      >
        <span className={cn("text-sm", muted)}>
          {state === "merged" ? "Merged — no further actions." : "Closed."}
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
        {onToggleDraftReview && canDecide && (
          <Button
            data-testid="review-toggle-draft"
            variant={draftReviewActive ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={onToggleDraftReview}
            title={
              draftReviewActive
                ? "Comments are batched into a draft review; submit with Approve/Request changes/Comment."
                : "Batch line comments before submitting one review."
            }
          >
            {draftReviewActive ? "Draft active" : "Start a review"}
          </Button>
        )}
        <Button
          data-testid="review-comment-submit"
          variant="outline"
          size="sm"
          disabled={!canDecide || busy || (body.trim().length === 0 && !draftReviewActive)}
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
