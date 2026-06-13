import { describe, expect, it } from "vitest";
import type { ForgejoIssue, ForgejoIssueComment } from "../forgejo-types.js";
import {
  chatBranchFromBody,
  chatIssueBody,
  chatLiveScript,
  chatReplyPending,
  chatTitleFrom,
  chatTurns,
  isChatIssue,
  renderChatTurn,
  stripChatMetadata,
} from "./web-chat.js";

const BOT = "coverify";

function issue(fields: Partial<ForgejoIssue>): ForgejoIssue {
  return {
    id: 1,
    number: 1,
    title: "Chat",
    body: "",
    state: "open",
    user: { id: 9, login: "alice" },
    assignees: null,
    labels: [],
    comments: 0,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
    closed_at: null,
    ...fields,
  };
}

function comment(login: string, body: string): ForgejoIssueComment {
  return {
    id: 1,
    body,
    user: { id: 1, login },
    created_at: "2026-05-20T00:01:00Z",
    updated_at: "2026-05-20T00:01:00Z",
  };
}

describe("chatTurns", () => {
  it("treats the issue body as the first user turn and classifies the bot as assistant", () => {
    const turns = chatTurns(issue({ body: "hi" }), [comment(BOT, "hello")], BOT);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns.map((t) => t.body)).toEqual(["hi", "hello"]);
  });

  it("classifies non-bot comment authors as the user", () => {
    const turns = chatTurns(issue({ body: "q1" }), [comment(BOT, "a1"), comment("alice", "q2")], BOT);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  it("skips empty/whitespace bodies", () => {
    const turns = chatTurns(issue({ body: "  " }), [comment("alice", "real"), comment(BOT, "")], BOT);
    expect(turns.map((t) => t.body)).toEqual(["real"]);
  });

  it("hides machine metadata from the visible turn body", () => {
    const body = chatIssueBody("Summarize the branch notes.", "agent/math");
    const turns = chatTurns(issue({ body }), [], BOT);
    expect(turns.map((t) => t.body)).toEqual(["Summarize the branch notes."]);
  });
});

describe("chat metadata", () => {
  it("records the pinned branch in a hidden markdown comment", () => {
    const body = chatIssueBody("Q", "agent/math");
    expect(body).toContain("cosheaf-chat-meta");
    expect(chatBranchFromBody(body)).toBe("agent/math");
    expect(stripChatMetadata(body)).toBe("Q");
  });
});

describe("chatReplyPending", () => {
  it("is true when there are no turns", () => {
    expect(chatReplyPending([])).toBe(true);
  });

  it("is true when the last turn is the user's", () => {
    expect(chatReplyPending(chatTurns(issue({ body: "hi" }), [], BOT))).toBe(true);
  });

  it("is false when the last turn is the assistant's", () => {
    expect(chatReplyPending(chatTurns(issue({ body: "hi" }), [comment(BOT, "done")], BOT))).toBe(false);
  });
});

describe("renderChatTurn", () => {
  it("emits the role-specific class and the pre-rendered body", () => {
    const [userTurn] = chatTurns(issue({ body: "hi" }), [], BOT);
    const html = renderChatTurn(userTurn, "<p>hi</p>");
    expect(html).toContain("chat-turn--user");
    expect(html).toContain(">You<");
    expect(html).toContain("<p>hi</p>");
  });

  it("labels assistant turns as Coverify", () => {
    const turns = chatTurns(issue({ body: "hi" }), [comment(BOT, "ok")], BOT);
    const html = renderChatTurn(turns[1], "<p>ok</p>");
    expect(html).toContain("chat-turn--assistant");
    expect(html).toContain(">Coverify<");
  });
});

describe("isChatIssue", () => {
  it("is true when the chat label is present", () => {
    expect(isChatIssue({ labels: [{ id: 1, name: "chat", color: "8b5cf6" }] })).toBe(true);
    expect(isChatIssue({ labels: [{ id: 2, name: "bug", color: "f00" }] })).toBe(false);
    expect(isChatIssue({ labels: [] })).toBe(false);
  });

  it("accepts hidden chat metadata as a fallback for direct chat links", () => {
    expect(isChatIssue({ labels: [], body: chatIssueBody("Q", "main") })).toBe(true);
    expect(isChatIssue({ labels: [], body: "<!-- cosheaf-chat-meta\n{}\n-->\nQ" })).toBe(false);
  });
});

describe("chatLiveScript", () => {
  it("subscribes to the workspace events stream and reloads on this issue's event", () => {
    const s = chatLiveScript("chao", "flushing-coin", 7);
    expect(s).toContain('new EventSource("/api/v1/repos/chao/flushing-coin/events")');
    expect(s).toContain('d.type==="issue"&&d.number===7');
    expect(s).toContain('querySelector(".chat-thread")');
    expect(s).not.toContain("location.reload");
  });
});

describe("chatTitleFrom", () => {
  it("uses the first non-empty line", () => {
    expect(chatTitleFrom("\n  Summarize the notes  \nmore")).toBe("Summarize the notes");
  });

  it("truncates long first lines", () => {
    expect(chatTitleFrom("x".repeat(200))).toHaveLength(80);
  });

  it("falls back to Chat for blank input", () => {
    expect(chatTitleFrom("   ")).toBe("Chat");
  });
});
