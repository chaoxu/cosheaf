// Review-comment plumbing for an open PR. Wraps the four api calls in
// one stable shape so WorkspaceView doesn't have to thread workspace.slug
// + reviewingPullNumber + pendingReviewId through every comment-related
// callback. Every mutator refreshes the comment list afterwards.

import { useCallback } from "react";
import { api, type LineComment } from "./api";

interface UseReviewCommentsArgs {
  slug: string;
  pullNumber: number | null;
  pendingReviewId: number | null;
  // Setter to apply the refreshed comment list into the caller's state shape.
  setComments: (next: LineComment[]) => void;
}

export interface ReviewCommentTarget {
  path: string;
  line: number;
  side: "head" | "base";
}

export interface UseReviewCommentsResult {
  refresh: () => void;
  add: (target: ReviewCommentTarget, body: string) => Promise<void>;
  edit: (commentId: number, body: string) => Promise<void>;
  remove: (commentId: number, reviewId: number) => Promise<void>;
}

export function useReviewComments({
  slug,
  pullNumber,
  pendingReviewId,
  setComments,
}: UseReviewCommentsArgs): UseReviewCommentsResult {
  const refresh = useCallback(() => {
    if (!pullNumber) return;
    api
      .listComments(slug, pullNumber)
      .then(setComments)
      .catch(() => undefined);
  }, [slug, pullNumber, setComments]);

  const add = useCallback(
    async (target: ReviewCommentTarget, body: string) => {
      if (!pullNumber) return;
      if (pendingReviewId) {
        await api.addPendingReviewComment(slug, pullNumber, pendingReviewId, { ...target, body });
      } else {
        await api.addComment(slug, pullNumber, { ...target, body });
      }
      refresh();
    },
    [slug, pullNumber, pendingReviewId, refresh],
  );

  const edit = useCallback(
    async (commentId: number, body: string) => {
      if (!pullNumber) return;
      await api.editComment(slug, pullNumber, commentId, body);
      refresh();
    },
    [slug, pullNumber, refresh],
  );

  const remove = useCallback(
    async (commentId: number, reviewId: number) => {
      if (!pullNumber) return;
      await api.deleteComment(slug, pullNumber, commentId, reviewId);
      refresh();
    },
    [slug, pullNumber, refresh],
  );

  return { refresh, add, edit, remove };
}
