import { describe, expect, it } from "vitest";
import { chatReplyArgs, isCoverifyChatEnabled } from "./coverify-cli.js";
import type { Config } from "./db.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoAdminToken: "admin-token",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  publicOrigin: null,
  registrationOpen: false,
  trustedProxyHops: 0,
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
};

describe("chatReplyArgs", () => {
  it("targets the workspace by its full owner/repo slug and preserves Coverify's backend flag", () => {
    expect(chatReplyArgs("chao/flushing-coin", 42, "coverify")).toEqual([
      "chat-reply",
      "--workspace",
      "chao/flushing-coin",
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
