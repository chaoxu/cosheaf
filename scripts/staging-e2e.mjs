#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const stagingUrl = process.env.COSHEAF_STAGING_URL ?? "https://cosheaf-test.lab/";
const grep = process.env.COSHEAF_STAGING_SMOKE_GREP ?? "@smoke-basic|@smoke-repo-home|@smoke-edit";

const env = {
  ...process.env,
  URL: stagingUrl,
  COSHEAF_SMOKE_OWNER: process.env.COSHEAF_SMOKE_OWNER ?? "chao",
  COSHEAF_SMOKE_WORKSPACE: process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin",
  COSHEAF_SMOKE_WORKSPACE_SLUG: process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin",
  COSHEAF_SMOKE_PAGE: process.env.COSHEAF_SMOKE_PAGE ?? "Hello",
  COSHEAF_SMOKE_PAGE_PATH: process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md",
  COSHEAF_SMOKE_USER: process.env.COSHEAF_SMOKE_USER ?? "chao",
  COSHEAF_SMOKE_PASSWORD: process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!",
  COSHEAF_EXPECTED_CLONE_URL: process.env.COSHEAF_EXPECTED_CLONE_URL ?? "ssh://git@cosheaf-test.lab:2224/chao/flushing-coin.git",
  COSHEAF_ADMIN_PASSWORD: process.env.COSHEAF_ADMIN_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!",
  COSHEAF_MERI_PASSWORD: process.env.COSHEAF_MERI_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!",
  COSHEAF_VERA_PASSWORD: process.env.COSHEAF_VERA_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!",
};

const result = spawnSync("pnpm", ["exec", "playwright", "test", "--config", "playwright.smoke.config.ts", "--grep", grep], {
  stdio: "inherit",
  env,
});
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const refs = spawnSync("node", [new URL("./staging-reference-smoke.mjs", import.meta.url).pathname, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

process.exit(refs.status ?? 1);
