// Single source of truth for the change-workflow vocabulary. Server and
// client both import this; the SQL CHECK clause derives from CHANGE_STATES
// via sqlInList so renames and additions stay in one place.

export const CHANGE_STATES = [
  "draft",
  "review",
  "changes_requested",
  "merged",
  "closed",
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export type Decision = "approve" | "request_changes" | "comment";

// Inline-able for SQLite CHECK clauses: `state TEXT NOT NULL CHECK (state IN ${sqlInList(CHANGE_STATES)})`
export function sqlInList(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}
