#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { pendingSummary } from "./devx-pending.mjs";

export function reviewPrompt({ verification = "", summary = pendingSummary() } = {}) {
  const lines = [
    "Review the current Cosheaf work before it is pushed or merged.",
    "",
    `Upstream: ${summary.upstream || "(none)"}`,
    `Working tree: ${summary.clean ? "clean" : "dirty"}`,
    `Commits ahead: ${summary.ahead}`,
  ];
  if (summary.commits.length > 0) {
    lines.push("", "Pending commits:");
    for (const commit of summary.commits) lines.push(`- ${commit}`);
  }
  if (summary.files.length > 0) {
    lines.push("", "Files to inspect:");
    for (const file of summary.files) lines.push(`- ${file}`);
  }
  if (summary.suggestions.length > 0) {
    lines.push("", "Suggested verification:");
    for (const item of summary.suggestions) lines.push(`- ${item.run}: ${item.reason}`);
  }
  if (verification.trim()) {
    lines.push("", "Verification already run:", verification.trim());
  }
  lines.push("", "Return findings with file/line references, or say no issues.");
  return `${lines.join("\n")}\n`;
}

function verificationText(values) {
  if (values.verificationFile) return readFileSync(values.verificationFile, "utf8");
  return values.verification ?? "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = new Command("devx-review-prompt")
    .option("--verification <text>", "verification notes to include")
    .option("--verification-file <path>", "file containing verification notes")
    .action((opts) => {
      process.stdout.write(reviewPrompt({ verification: verificationText(opts) }));
    });
  program.parse(normalizeArgv(process.argv));
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}
