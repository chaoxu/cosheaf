import { spawn } from "node:child_process";
import type { Config } from "./db.js";

// Build the argv for `coverify chat-reply`. The repo/owner is identified by the
// workspace slug (the client targets /w/{workspace}/...), not a separate flag.
// Auth (api-url + bot token) is passed through the environment, not argv.
export function chatReplyArgs(workspace: string, issue: number, botLogin: string): string[] {
  return [
    "chat-reply",
    "--workspace",
    workspace,
    "--issue",
    String(issue),
    "--bot-user",
    botLogin,
    "--backend",
    "verifying",
  ];
}

// Fire-and-forget the coverify reply for one chat turn. Coverify reads the
// thread, runs the verifying oracle, and posts its own reply comment as the
// dedicated bot account. This never blocks the HTTP redirect and never throws:
// the user's message is already persisted, so a failure here is only logged.
export function runCoverifyChatReply(config: Config, opts: { workspace: string; issue: number }): void {
  if (!config.coverifyBotToken) return;
  const args = chatReplyArgs(opts.workspace, opts.issue, config.coverifyBotLogin);
  const child = spawn(config.coverifyCmd, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COSHEAF_API_URL: config.coverifyApiUrl,
      COSHEAF_TOKEN: config.coverifyBotToken,
    },
  });
  child.on("error", (err) => {
    console.error(`coverify chat-reply failed to start (issue #${opts.issue}):`, err);
  });
  child.unref();
}
