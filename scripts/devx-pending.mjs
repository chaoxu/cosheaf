#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { changedFiles, suggestChecks } from "./devx-what-to-run.mjs";

export function pendingSummary({
  upstream,
  gitFn = git,
  gitOneFn = (args) => gitFn(args)[0] ?? "",
} = {}) {
  const resolvedUpstream = upstream ?? gitOneFn(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const dirtyFiles = [
    ...gitFn(["diff", "--name-only", "HEAD"]),
    ...gitFn(["diff", "--name-only", "--cached"]),
    ...gitFn(["ls-files", "--others", "--exclude-standard"]),
  ];
  const commits = resolvedUpstream ? gitFn(["log", "--oneline", `${resolvedUpstream}..HEAD`]) : [];
  const files = dirtyFiles.length > 0 ? dirtyFiles : changedFiles(null, gitFn, () => resolvedUpstream);
  return {
    upstream: resolvedUpstream,
    clean: dirtyFiles.length === 0,
    ahead: commits.length,
    commits,
    files: [...new Set(files)].sort(),
    suggestions: suggestChecks(files).suggestions,
  };
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function printText(summary) {
  console.log(`Upstream: ${summary.upstream || "(none)"}`);
  console.log(`Working tree: ${summary.clean ? "clean" : "dirty"}`);
  console.log(`Commits ahead: ${summary.ahead}`);
  if (summary.commits.length > 0) {
    console.log("\nPending commits:");
    for (const commit of summary.commits) console.log(`  - ${commit}`);
  }
  if (summary.files.length > 0) {
    console.log("\nChanged files considered:");
    for (const file of summary.files) console.log(`  - ${file}`);
  }
  console.log("\nSuggested checks:");
  for (const item of summary.suggestions) {
    console.log(`  - ${item.run}`);
    console.log(`    ${item.reason}`);
  }
  console.log(`\nPush readiness: ${summary.clean && summary.ahead > 0 ? "ready after checks/review" : "not ready yet"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = new Command("devx-pending")
    .option("--json", "emit machine-readable JSON", false)
    .action((opts) => {
      const summary = pendingSummary();
      if (opts.json) console.log(JSON.stringify(summary, null, 2));
      else printText(summary);
    });
  program.parse(normalizeArgv(process.argv));
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}
