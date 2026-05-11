// Single source of truth for the change-workflow vocabulary. Server and
// client both import this; the SQL migration derives its CHECK clause from
// CHANGE_STATES so renames and additions stay in one place.

export const CHANGE_STATES = [
  "draft",
  "review",
  "changes_requested",
  "merged",
  "closed",
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export const WRITABLE_STATES = ["draft", "changes_requested"] as const satisfies readonly ChangeState[];
export const TERMINAL_STATES = ["merged", "closed"] as const satisfies readonly ChangeState[];

export type WritableChangeState = (typeof WRITABLE_STATES)[number];
export type TerminalChangeState = (typeof TERMINAL_STATES)[number];

export const DECISIONS = ["approve", "request_changes", "comment"] as const;
export type Decision = (typeof DECISIONS)[number];

export const SSE_EVENT_TYPES = [
  "queue",
  "change",
  "remove",
  "change_review",
  "change_changes_requested",
  "change_approved",
  "change_commented",
  "change_merged",
  "change_closed",
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

// Inline-able for SQLite CHECK clauses: `state TEXT NOT NULL CHECK (state IN ${sqlInList(CHANGE_STATES)})`
export function sqlInList(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}
