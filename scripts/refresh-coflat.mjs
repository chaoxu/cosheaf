#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["--dir", "../coflat", "build"]);
run("pnpm", ["install", "--ignore-scripts"], { env: { CI: "true" } });
run("pnpm", ["rebuild", "better-sqlite3", "esbuild"]);

