import { describe, expect, it } from "vitest";
import { chatReplyArgs } from "./coverify-cli.js";

describe("chatReplyArgs", () => {
  it("targets the workspace + issue and pins the verifying backend", () => {
    expect(chatReplyArgs("flushing-coin", 42, "coverify")).toEqual([
      "chat-reply",
      "--workspace",
      "flushing-coin",
      "--issue",
      "42",
      "--bot-user",
      "coverify",
      "--backend",
      "verifying",
    ]);
  });
});
