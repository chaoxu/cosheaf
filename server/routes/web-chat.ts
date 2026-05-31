import type { ForgejoIssue, ForgejoIssueComment } from "../forgejo-types.js";

// The label that marks an issue as created through the chat UI. Only the chat
// "new" route applies it, so the list can find exactly those issues.
export const CHAT_LABEL = "chat";

export interface ChatTurn {
  role: "user" | "assistant";
  author: string;
  body: string;
  createdAt: string;
}

// Build the conversation from an issue: the opening post is the first turn and
// each comment is a turn. A turn is the assistant's iff its author is the bot
// account; everything else is the user. Mirrors coverify's extract_turns so
// both sides agree on who said what. Empty bodies are skipped.
export function chatTurns(issue: ForgejoIssue, comments: ForgejoIssueComment[], botLogin: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const push = (author: string | null | undefined, body: string, createdAt: string) => {
    if (!body.trim()) return;
    const login = author ?? "";
    turns.push({ role: login && login === botLogin ? "assistant" : "user", author: login, body, createdAt });
  };
  push(issue.user?.login, issue.body ?? "", issue.created_at);
  for (const comment of comments) push(comment.user?.login, comment.body ?? "", comment.created_at);
  return turns;
}

// A reply is pending whenever the conversation is empty or its last turn is the
// user's — i.e. coverify still owes an answer. Drives the "thinking…"
// placeholder and the thread's auto-reload.
export function chatReplyPending(turns: ChatTurn[]): boolean {
  return turns.length === 0 || turns[turns.length - 1].role === "user";
}

// Render one turn. The body is pre-rendered markdown HTML (done in the route,
// which has the async markdown surface) so this module stays pure and testable.
export function renderChatTurn(turn: ChatTurn, bodyHtml: string): string {
  const label = turn.role === "assistant" ? "Coverify" : "You";
  return `<div class="chat-turn chat-turn--${turn.role}">
      <div class="chat-role">${label}</div>
      <div class="chat-bubble">${bodyHtml}</div>
    </div>`;
}

// Derive a concise issue title from the first message: its first non-empty line,
// trimmed to a reasonable length.
export function chatTitleFrom(message: string): string {
  const firstLine = message.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  if (!firstLine) return "Chat";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

// The "thinking…" placeholder turn shown while coverify works, plus a tiny
// auto-reload so the reply appears without a manual refresh.
export function chatPendingTurn(): string {
  return `<div class="chat-turn chat-turn--assistant chat-pending">
      <div class="chat-role">Coverify</div>
      <div class="chat-bubble">thinking…</div>
    </div>
    <script>setTimeout(function(){location.reload();},4000);</script>`;
}
