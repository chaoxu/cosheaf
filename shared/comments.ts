// Line-level review comments for the PR view. Shared by server and client.

// PR-native side vocabulary: `base` = the PR's base ref (left side of diff,
// pre-change line); `head` = the PR's head ref (right side, post-change line).
// Forgejo's review-comment write API consumes new_position/old_position
// integers — head maps to new_position, base maps to old_position.
export type CommentSide = "base" | "head";

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
