#!/usr/bin/env node

import { parseArgs } from "node:util";
import { smokeChecks } from "./smoke-manifest.mjs";
import { run } from "./lib/run.mjs";

const targets = {
  prod: {
    url: "https://cosheaf.lab/",
    workspace: "poa-network-game-oracle-first",
    slug: "poa-network-game-oracle-first",
    page: "Hello",
    pagePath: "hello.md",
    prod: true,
  },
};

function targetFor(value) {
  return targets[value] ?? {
    url: value,
    workspace: process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin",
    slug: process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin",
    page: process.env.COSHEAF_SMOKE_PAGE ?? "Hello",
    pagePath: process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md",
    prod: false,
  };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { destructive: { type: "boolean", default: false } },
});
const targetArg = positionals[0];
if (!targetArg) {
  console.error("usage: jupiter-e2e <prod|url> [--destructive]");
  process.exit(2);
}
const target = targetFor(targetArg);
const destructive = values.destructive || process.env.COSHEAF_E2E_DESTRUCTIVE === "1";
const checks = smokeChecks.filter((check) => (!target.prod || check.prod) && (!check.destructive || destructive));
const grep = checks.map((check) => check.grep).join("|");
run("pnpm", ["exec", "playwright", "test", "--config", "playwright.smoke.config.ts", "--grep", grep], {
  env: {
    ...process.env,
    URL: target.url,
    COSHEAF_SMOKE_USER: process.env.COSHEAF_SMOKE_USER ?? "chao",
    COSHEAF_SMOKE_PASSWORD: process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
    COSHEAF_SMOKE_WORKSPACE: target.workspace,
    COSHEAF_SMOKE_WORKSPACE_SLUG: target.slug,
    COSHEAF_SMOKE_PAGE: target.page,
    COSHEAF_SMOKE_PAGE_PATH: target.pagePath,
    COSHEAF_ADMIN_PASSWORD: process.env.COSHEAF_ADMIN_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
    COSHEAF_MERI_PASSWORD: process.env.COSHEAF_MERI_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
    COSHEAF_VERA_PASSWORD: process.env.COSHEAF_VERA_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
  },
});
console.log(`\nE2E checks passed for ${target.url}`);
