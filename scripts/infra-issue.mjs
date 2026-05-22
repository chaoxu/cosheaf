#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function usage() {
  console.error("usage: node scripts/infra-issue.mjs --title <title> --body <body>");
  process.exit(2);
}

function valueFlag(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

const args = process.argv.slice(2);
const title = valueFlag(args, "--title");
const body = valueFlag(args, "--body") ?? valueFlag(args, "--description");
if (!title || !body) usage();

const result = spawnSync("tea", [
  "issues",
  "create",
  "--repo",
  "chaoxu/fleet-infra",
  "--title",
  title,
  "--description",
  body,
], {
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);

