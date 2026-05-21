#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const targets = {
  prod: {
    url: "https://cosheaf.lab/",
    workspace: "Flushing Coin",
    slug: "flushing-coin",
    pagePath: "hello.md",
  },
  staging: {
    url: "http://127.0.0.1:3031/",
    workspace: "Staging Coin",
    slug: "staging-coin",
    pagePath: "hello.md",
  },
  testing: {
    url: "http://127.0.0.1:3032/",
    workspace: "Staging Coin",
    slug: "staging-coin",
    pagePath: "hello.md",
  },
};

function usage() {
  console.error("usage: node scripts/jupiter-e2e.mjs <prod|staging|testing|URL> [--destructive]");
  process.exit(2);
}

const [targetArg, maybeDestructive] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!targetArg) usage();

const destructive = maybeDestructive === "--destructive" || process.env.COSHEAF_E2E_DESTRUCTIVE === "1";
const target = targets[targetArg] ?? {
  url: targetArg,
  workspace: process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin",
  slug: process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin",
  pagePath: process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md",
};

const baseEnv = {
  ...process.env,
  URL: target.url,
  COSHEAF_SMOKE_USER: process.env.COSHEAF_SMOKE_USER ?? "chao",
  COSHEAF_SMOKE_PASSWORD: process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
  COSHEAF_SMOKE_WORKSPACE: target.workspace,
  COSHEAF_SMOKE_WORKSPACE_SLUG: target.slug,
  COSHEAF_SMOKE_PAGE: process.env.COSHEAF_SMOKE_PAGE ?? "Hello",
  COSHEAF_SMOKE_PAGE_PATH: target.pagePath,
  COSHEAF_ADMIN_PASSWORD: process.env.COSHEAF_ADMIN_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
  COSHEAF_MERI_PASSWORD: process.env.COSHEAF_MERI_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
  COSHEAF_VERA_PASSWORD: process.env.COSHEAF_VERA_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "123123aA",
};

const checks = [
  ["smoke", "scripts/browser-smoke.mjs"],
  ["issues-nav", "scripts/browser-issues-nav.mjs"],
];
if (destructive) {
  checks.push(["direct-merge", "scripts/browser-flow.mjs"]);
  checks.push(["review-merge", "scripts/browser-flow-review.mjs"]);
}

for (const [name, script] of checks) {
  console.log(`\n== ${name} @ ${target.url}`);
  const result = spawnSync("node", [script], {
    stdio: "inherit",
    env: {
      ...baseEnv,
      SCREENSHOT: `/tmp/cosheaf-${targetArg.replace(/[^a-z0-9]/gi, "-")}-${name}.png`,
      COSHEAF_FLOW_PATH: `${targetArg.replace(/[^a-z0-9]/gi, "-")}-${name}-${Date.now()}.md`,
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nE2E checks passed for ${target.url}`);
