import type { CommentSide, LineComment, PrFile } from "../api";

export type ViewMode = "source" | "rich";
export type ViewShape = "unified" | "split" | "after";

export interface AddCommentTarget {
  path: string;
  line: number;
  side: CommentSide;
}

export interface DiffRendererProps {
  file: PrFile;
  loadContent: (side: "base" | "head") => Promise<string>;
  comments: readonly LineComment[];
  // Identity of the viewer so each renderer can offer edit/delete on the
  // viewer's own comments without re-asking the server.
  currentForgejoUsername?: string;
  // When set, the renderer shows a gutter affordance so the reviewer
  // can click a line to add a comment. The handler shows an inline composer.
  onAddComment?: (target: AddCommentTarget, body: string) => Promise<void>;
  onEditComment?: (commentId: number, body: string) => Promise<void>;
  onDeleteComment?: (commentId: number, reviewId: number) => Promise<void>;
}
