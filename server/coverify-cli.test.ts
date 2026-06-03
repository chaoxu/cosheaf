import { describe, expect, it } from "vitest";
import { chatReplyArgs, isCoverifyChatEnabled } from "./coverify-cli.js";
import type { Config } from "./db.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoAdminToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
};

describe("chatReplyArgs", () => {
  it("targets the workspace + issue and preserves Coverify's backend flag", () => {
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

describe("isCoverifyChatEnabled", () => {
  it("requires both the bot token and bot login", () => {
    expect(isCoverifyChatEnabled(config)).toBe(false);
    expect(isCoverifyChatEnabled({ ...config, coverifyBotToken: "token" })).toBe(true);
    expect(isCoverifyChatEnabled({ ...config, coverifyBotToken: "token", coverifyBotLogin: "" })).toBe(false);
  });
});
