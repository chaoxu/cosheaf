import type { ForgejoIssue, ForgejoIssueComment } from "../forgejo-types.js";

// The label that marks an issue as created through the chat UI. Only the chat
// "new" route applies it, so the list can find exactly those issues.
export const CHAT_LABEL = "chat";
export const CHAT_META_MARKER = "cosheaf-chat-meta";
const CHAT_META_RE = new RegExp(`<!--\\s*${CHAT_META_MARKER}\\s*(\\{[\\s\\S]*?\\})\\s*-->`, "m");

// True only if the issue actually carries the chat label. Forgejo's
// `labels=chat` list filter silently returns everything when no such label
// exists in the repo, so we must verify the label ourselves rather than trust
// the query — keeping the list, the thread, and the Issues-tab hiding consistent.
export function isChatIssue(issue: Pick<ForgejoIssue, "labels">): boolean {
  return issue.labels.some((label) => label.name === CHAT_LABEL);
}

export interface ChatTurn {
  role: "user" | "assistant";
  author: string;
  body: string;
  createdAt: string;
}

export function chatMetadataComment(metadata: Record<string, unknown>): string {
  return `<!-- ${CHAT_META_MARKER}\n${JSON.stringify(metadata, null, 2)}\n-->`;
}

export function chatIssueBody(message: string, branch: string): string {
  return `${chatMetadataComment({ kind: "cosheaf-chat", branch })}\n\n${message.trim()}`.trim();
}

export function chatMetadata(body: string): Record<string, unknown> {
  const match = body.match(CHAT_META_RE);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (_err) {
    return {};
  }
}

export function chatBranchFromBody(body: string): string | null {
  const branch = chatMetadata(body).branch;
  return typeof branch === "string" && branch.trim() ? branch : null;
}

export function stripChatMetadata(body: string): string {
  return body.replace(CHAT_META_RE, "").trim();
}

// Build the conversation from an issue: the opening post is the first turn and
// each comment is a turn. A turn is the assistant's iff its author is the bot
// account; everything else is the user. Mirrors coverify's extract_turns so
// both sides agree on who said what. Empty bodies are skipped.
export function chatTurns(issue: ForgejoIssue, comments: ForgejoIssueComment[], botLogin: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const push = (author: string | null | undefined, body: string, createdAt: string) => {
    const visibleBody = stripChatMetadata(body);
    if (!visibleBody.trim()) return;
    const login = author ?? "";
    turns.push({ role: login && login === botLogin ? "assistant" : "user", author: login, body: visibleBody, createdAt });
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

// The "thinking…" placeholder turn shown while coverify still owes a reply.
export function chatPendingTurn(): string {
  return `<div class="chat-turn chat-turn--assistant chat-pending">
      <div class="chat-role">Coverify</div>
      <div class="chat-bubble">thinking…</div>
    </div>`;
}

// Subscribe to the workspace SSE stream (cookie-authed, same origin) and, when
// THIS issue gets an event (e.g. coverify posts its reply), fetch the thread and
// swap just the .chat-thread contents in place — no full-page reload. Event-
// driven, not a timer; stops once the reply has landed. Rendered only while a
// reply is pending.
export function chatLiveScript(slug: string, issue: number): string {
  const url = `/api/v1/w/${encodeURIComponent(slug)}/events`;
  return `<script>(function(){try{var es=new EventSource(${JSON.stringify(url)});es.onmessage=function(ev){try{var d=JSON.parse(ev.data);if(!(d&&d.type==="issue"&&d.number===${issue}))return;fetch(location.href,{credentials:"same-origin"}).then(function(r){return r.text();}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector(".chat-thread");var cur=document.querySelector(".chat-thread");if(next&&cur){cur.innerHTML=next.innerHTML;cur.scrollIntoView(false);if(!cur.querySelector(".chat-pending"))es.close();}}).catch(function(){});}catch(e){}};window.addEventListener("pagehide",function(){es.close();});}catch(e){}})();</script>`;
}
