import { spawn } from "node:child_process";
import type { Config } from "./db.js";

export function isCoverifyChatEnabled(config: Config): boolean {
  return config.coverifyBotToken.trim().length > 0 && config.coverifyBotLogin.trim().length > 0;
}

// Build the argv for `coverify chat-reply`. The repo/owner is identified by the
// full workspace slug "owner/repo" (the client targets /repos/{owner}/{repo}/...),
// not a separate flag. Auth (api-url + bot token) is passed through the
// environment, not argv.
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

// Fire-and-forget the coverify reply for one chat turn. The external Coverify
// worker reads the thread and posts its own reply comment as the dedicated bot
// account. This never blocks the HTTP redirect and never throws: the user's
// message is already persisted, so a failure here is only logged.
export function runCoverifyChatReply(config: Config, opts: { workspace: string; issue: number }): void {
  if (!isCoverifyChatEnabled(config)) return;
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
