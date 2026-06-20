#!/usr/bin/env node

import { spawnSync } from "node:child_process";

console.warn("jupiter:e2e is deprecated; use pnpm prod:e2e -- prod. Production is Pluto.");

const result = spawnSync("node", [new URL("./prod-e2e.mjs", import.meta.url).pathname, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
