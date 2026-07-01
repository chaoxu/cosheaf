import { canWrite, type Role } from "../../shared/roles.js";
import type { Hono } from "hono";
import { isCoverifyChatEnabled, runCoverifyChatReply } from "../coverify-cli.js";
import type { Forgejo } from "../forgejo.js";
import { onForgejo404 } from "../forgejo-errors.js";
import type { ForgejoIssue } from "../forgejo-types.js";
import type { AppEnv } from "../types.js";
import {
  CHAT_LABEL,
  chatBranchFromBody,
  chatIssueBody,
  chatLiveScript,
  chatPendingTurn,
  chatReplyPending,
  chatTitleFrom,
  chatTurns,
  isChatIssue,
  renderChatTurn,
} from "./web-chat.js";
import {
  badRequestPage,
  htmlResponse,
  notFoundPage,
  positiveInt,
  redirect,
  repoHref,
  stringField,
  webRoute,
  webRouteForWrite,
  type WebCtx,
} from "./web-context.js";
import { validBranchName } from "../branch-path.js";
import { eyeIcon } from "./icons.js";
import { emptyHtml, html, type Html, raw } from "./web-html.js";
import { renderMarkdownSurface } from "./web-markdown.js";
import { branchOptions, repoPageShell } from "./web-page.js";

// Find the "chat" label id, creating it once if missing. Chats are issues
// carrying this label, applied only by the chat "new" route.
async function ensureChatLabel(fj: Forgejo, owner: string, repo: string): Promise<number> {
  const labels = await fj.listLabels(owner, repo);
  const existing = labels.find((label) => label.name === CHAT_LABEL);
  if (existing) return existing.id;
  const created = await fj.createLabel(owner, repo, { name: CHAT_LABEL, color: "8b5cf6", description: "Coverify chat" });
  return created.id;
}

// Issue-backed chat sidebar: a "New chat" entry plus one row per chat issue,
// with the active issue highlighted. Shared by the list and thread views.
function listChats(ctx: WebCtx) {
  return Promise.all([
    ctx.fj.listIssues(ctx.owner, ctx.repo, { labels: CHAT_LABEL, state: "open", limit: 50 }).catch(() => [] as ForgejoIssue[]),
    ctx.fj.listIssues(ctx.owner, ctx.repo, { state: "open", limit: 50 }).catch(() => [] as ForgejoIssue[]),
  ]).then(([labeled, recent]) => {
    const byNumber = new Map<number, ForgejoIssue>();
    for (const issue of [...labeled, ...recent]) {
      if (isChatIssue(issue)) byNumber.set(issue.number, issue);
    }
    return [...byNumber.values()].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  });
}

function chatSidebar(
  owner: string,
  repo: string,
  chats: ForgejoIssue[],
  active: number | null,
  role: Role,
  canStartChat: boolean,
): Html {
  const newChat =
    !canWrite(role) || !canStartChat
      ? emptyHtml
      : html`<a class="chat-new-link${active === null ? " active" : ""}" href="${repoHref(owner, repo, "/chat")}">+ New chat</a>`;
  const sessions =
    chats.length === 0
      ? html`<div class="chat-sessions-empty">No chats yet</div>`
      : chats.map(
          (chat) =>
            html`<a class="chat-session${chat.number === active ? " active" : ""}" href="${repoHref(owner, repo, `/chat/${chat.number}`)}" title="${chat.title}">${chat.title}</a>`,
        );
  return html`<aside class="chat-sidebar">${newChat}<nav class="chat-sessions">${sessions}</nav></aside>`;
}

export function registerChatPageRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/chat", webRoute(async (c, ctx) => {
  const canStartChat = ctx.ws.role !== "read" && isCoverifyChatEnabled(c.get("config"));
  const [chats, branches] = await Promise.all([
    listChats(ctx),
    canStartChat ? ctx.fj.listBranches(ctx.owner, ctx.repo) : Promise.resolve([]),
  ]);
  return htmlResponse(
    repoPageShell(ctx, "chat", `Chat - ${ctx.repo}`, html`
        <div class="chat-app">
          ${chatSidebar(ctx.owner, ctx.repo, chats, null, ctx.ws.role, canStartChat)}
          <section class="chat-main">
            <p class="chat-notice">${eyeIcon({ size: 14 })}Everyone with access to this workspace can see these chats — they're not private.</p>
            ${
              !canWrite(ctx.ws.role)
                ? html`<div class="chat-blank">Read-only access — you can't start chats here.</div>`
                : !canStartChat
                  ? html`<div class="chat-blank">Chat is not configured for this Cosheaf instance. Existing chat issues remain readable.</div>`
                : html`<div class="chat-blank">Start a new chat with Coverify, or pick a chat on the left.</div>
                   <form class="chat-composer" method="post" action="${repoHref(ctx.owner, ctx.repo, "/chat/new")}">
                     <label>Branch
                       <select name="branch" data-option-icon="branch">${branchOptions(branches, "main")}</select>
                     </label>
                     <textarea name="message" placeholder="Start a chat with Coverify" required></textarea>
                     <button class="button primary" type="submit">Send</button>
                   </form>`
            }
          </section>
        </div>
      `),
  );
}));

web.post("/:owner/:repo/chat/new", webRouteForWrite(async (c, ctx) => {
  if (!isCoverifyChatEnabled(c.get("config"))) return badRequestPage(ctx.user, "Chat is not configured.");
  const form = await c.req.parseBody();
  const message = stringField(form.message);
  if (!message) return redirect(repoHref(ctx.owner, ctx.repo, "/chat"));
  const branch = stringField(form.branch) || "main";
  if (!validBranchName(branch)) return badRequestPage(ctx.user, "Valid branch name is required.");
  const branchExists = await ctx.fj.getBranch(ctx.owner, ctx.repo, branch);
  if (!branchExists) return badRequestPage(ctx.user, "Branch does not exist.");
  const labelId = await ensureChatLabel(ctx.fj, ctx.owner, ctx.repo);
  const issue = await ctx.fj.createIssue(ctx.owner, ctx.repo, {
    title: chatTitleFrom(message),
    body: chatIssueBody(message, branch),
    labels: [labelId],
  });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number: issue.number, action: "opened" });
  runCoverifyChatReply(c.get("config"), { workspace: ctx.ws.slug, issue: issue.number });
  return redirect(repoHref(ctx.owner, ctx.repo, `/chat/${issue.number}`));
}));

web.get("/:owner/:repo/chat/:number", webRoute(async (c, ctx) => {
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Chat not found");
  const [issue, comments, chats] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch(onForgejo404(null)),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
    listChats(ctx),
  ]);
  if (!issue || issue.pull_request || !isChatIssue(issue)) {
    return notFoundPage(ctx.user, "Chat not found");
  }
  const chatBranch = chatBranchFromBody(issue.body ?? "") ?? "main";
  const canSendChat = ctx.ws.role !== "read" && isCoverifyChatEnabled(c.get("config"));
  const turns = chatTurns(issue, comments, c.get("config").coverifyBotLogin);
  // web-chat.js is a pure string module (unit-tested on primitive strings), so
  // its handcrafted markup is re-marked as Html at this boundary.
  const renderedTurns = await Promise.all(
    turns.map(async (turn) => raw(renderChatTurn(turn, await renderMarkdownSurface(ctx, turn.body, { surface: "thread" })))),
  );
  return htmlResponse(
    repoPageShell(ctx, "chat", `${issue.title} - Chat`, html`
        <div class="chat-app">
          ${chatSidebar(ctx.owner, ctx.repo, chats, number, ctx.ws.role, canSendChat)}
          <section class="chat-main">
            <div class="chat-main-head">
              <div>
                <p class="eyebrow">Issue #${issue.number} · workspace-visible chat</p>
                <h1>${issue.title}</h1>
                <p class="chat-context">Repository snapshot: ${chatBranch}</p>
              </div>
              <div class="toolbar-actions"><button class="button" type="button" onclick="navigator.clipboard?.writeText(location.href)">Copy link</button></div>
            </div>
            <div class="chat-thread">
              ${renderedTurns}
              ${chatReplyPending(turns) ? raw(chatPendingTurn()) : ""}
            </div>
            ${chatReplyPending(turns) ? raw(chatLiveScript(ctx.owner, ctx.repo, number)) : ""}
            ${
              !canSendChat
                ? ""
                : html`<form class="chat-composer" method="post" action="${repoHref(ctx.owner, ctx.repo, `/chat/${number}/send`)}">
                     <textarea name="message" placeholder="Message Coverify" required></textarea>
                     <button class="button primary" type="submit">Send</button>
                   </form>`
            }
          </section>
        </div>
      `, { readerAssets: ctx.coflat }),
  );
}));

web.post("/:owner/:repo/chat/:number/send", webRouteForWrite(async (c, ctx) => {
  if (!isCoverifyChatEnabled(c.get("config"))) return badRequestPage(ctx.user, "Chat is not configured.");
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Chat not found");
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch(() => null);
  if (!issue || issue.pull_request || !isChatIssue(issue)) {
    return notFoundPage(ctx.user, "Chat not found");
  }
  const message = stringField((await c.req.parseBody()).message);
  if (message) {
    await ctx.fj.createIssueComment(ctx.owner, ctx.repo, number, message);
    c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "commented" });
    runCoverifyChatReply(c.get("config"), { workspace: ctx.ws.slug, issue: number });
  }
  return redirect(repoHref(ctx.owner, ctx.repo, `/chat/${number}`));
}));
}
