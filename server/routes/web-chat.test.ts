import { describe, expect, it } from "vitest";
import type { ForgejoIssue, ForgejoIssueComment } from "../forgejo-types.js";
import { chatLiveScript, chatReplyPending, chatTitleFrom, chatTurns, renderChatTurn } from "./web-chat.js";

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

describe("chatLiveScript", () => {
  it("subscribes to the workspace events stream and reloads on this issue's event", () => {
    const s = chatLiveScript("flushing-coin", 7);
    expect(s).toContain('new EventSource("/api/v1/w/flushing-coin/events")');
    expect(s).toContain('d.type==="issue"&&d.number===7');
    expect(s).toContain('querySelector(".chat-thread")');
    expect(s).not.toContain("location.reload");
  });
});

describe("chatTitleFrom", () => {
  it("uses the first non-empty line", () => {
    expect(chatTitleFrom("\n  Prove the lemma  \nmore")).toBe("Prove the lemma");
  });

  it("truncates long first lines", () => {
    expect(chatTitleFrom("x".repeat(200))).toHaveLength(80);
  });

  it("falls back to Chat for blank input", () => {
    expect(chatTitleFrom("   ")).toBe("Chat");
  });
});
