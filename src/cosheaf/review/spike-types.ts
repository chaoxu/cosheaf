import type { CommentSide, LineComment, PullFile } from "../api";

export type SpikeId = "unified" | "split" | "rendered";

export interface AddCommentTarget {
  path: string;
  line: number;
  side: CommentSide;
}

export interface SpikeProps {
  file: PullFile;
  loadContent: (side: "base" | "head") => Promise<string>;
  comments: readonly LineComment[];
  // Identity of the viewer so each spike can offer edit/delete on the
  // viewer's own comments without re-asking the server.
  currentForgejoUsername?: string;
  // Phase 2b: when set, the spike renders a gutter affordance so the reviewer
  // can click a line to add a comment. The handler shows an inline composer.
  onAddComment?: (target: AddCommentTarget, body: string) => Promise<void>;
  onEditComment?: (commentId: number, body: string) => Promise<void>;
  onDeleteComment?: (commentId: number, reviewId: number) => Promise<void>;
}
