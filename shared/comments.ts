// Line-level review comments for the PR view. Shared by server and client.

export type CommentSide = "new" | "old";

export interface LineComment {
  id: number;
  review_id: number;
  path: string;
  // Absolute line number on the resolved side. `null` when the underlying
  // diff has moved since the comment was posted (Forgejo marks the comment
  // as outdated by nulling its position).
  line: number | null;
  side: CommentSide;
  body: string;
  author_username: string;
  created_at: number;
  updated_at: number;
  outdated: boolean;
}
