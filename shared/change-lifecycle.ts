// Single source of truth for the branch / pull-request workflow vocabulary.
// Server and client both import this; the SQL CHECK clause derives from
// BRANCH_STATES via sqlInList so renames and additions stay in one place.

export const BRANCH_STATES = [
  "draft",
  "review",
  "changes_requested",
  "merged",
  "closed",
] as const;
export type BranchState = (typeof BRANCH_STATES)[number];
/** @deprecated use BranchState */
export type ChangeState = BranchState;
/** @deprecated use BRANCH_STATES */
export const CHANGE_STATES = BRANCH_STATES;

export type Decision = "approve" | "request_changes" | "comment";

// Inline-able for SQLite CHECK clauses: `state TEXT NOT NULL CHECK (state IN ${sqlInList(BRANCH_STATES)})`
export function sqlInList(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}
