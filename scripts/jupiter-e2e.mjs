#!/usr/bin/env node

import { Command } from "commander";
import { smokeChecks } from "./smoke-manifest.mjs";
import { run } from "./lib/run.mjs";

const targets = {
  prod: {
    url: "https://cosheaf.lab/",
    workspace: "Flushing Coin",
    slug: "flushing-coin",
    pagePath: "hello.md",
  },
};

function targetFor(value) {
  return targets[value] ?? {
    url: value,
    workspace: process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin",
    slug: process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin",
    pagePath: process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md",
  };
}

const program = new Command("jupiter-e2e")
  .argument("<prod-or-url>", "prod or an explicit preview URL")
  .option("--destructive", "also run mutating merge/review flows", false)
  .action((targetArg, opts) => {
    const target = targetFor(targetArg);
    const destructive = opts.destructive || process.env.COSHEAF_E2E_DESTRUCTIVE === "1";
    const checks = smokeChecks.filter((check) => !check.destructive || destructive);
    const grep = checks.map((check) => check.grep).join("|");
    run("pnpm", ["exec", "playwright", "test", "tests/e2e/smoke.spec.ts", "--grep", grep], {
      env: {
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
      },
    });
    console.log(`\nE2E checks passed for ${target.url}`);
  });

program.parse(process.argv);

