#!/usr/bin/env node

// Rewrite the pinned coflat SHA across every site that carries it: the checker's
// DEFAULT_COFLAT_REF (the single source of truth), setup docs, Docker/Compose,
// and CI. CLAUDE.md is a symlink to AGENTS.md, so it follows.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

const SITES = [
  {
    file: "scripts/check-coflat-ref.mjs",
    re: /(export const DEFAULT_COFLAT_REF = ")[0-9a-f]{40}(";)/,
    repl: (sha) => `$1${sha}$2`,
  },
  { file: "README.md", re: /(coflat checkout )[0-9a-f]{40}/, repl: (sha) => `$1${sha}` },
  { file: "AGENTS.md", re: /(coflat checkout )[0-9a-f]{40}/, repl: (sha) => `$1${sha}` },
  { file: "Dockerfile", re: /(ARG COFLAT_GIT_REF=)[0-9a-f]{40}/, repl: (sha) => `$1${sha}` },
  { file: "compose.yaml", re: /(COFLAT_GIT_REF: \$\{COFLAT_GIT_REF:-)[0-9a-f]{40}(\})/g, repl: (sha) => `$1${sha}$2` },
  { file: ".github/workflows/ci.yml", re: /(COFLAT_REF: )[0-9a-f]{40}/, repl: (sha) => `$1${sha}` },
  { file: ".gitea/workflows/ci.yml", re: /(COFLAT_REF: )[0-9a-f]{40}/, repl: (sha) => `$1${sha}` },
];

export function bumpCoflat({ sha, repoRoot = process.cwd() }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`not a 40-hex coflat sha: ${sha}`);
  }
  const replacements = [];
  const updated = [];
  for (const site of SITES) {
    const path = resolve(repoRoot, site.file);
    const text = readFileSync(path, "utf8");
    if (!site.re.test(text)) {
      throw new Error(`no coflat pin found in ${site.file} (pattern ${site.re})`);
    }
    replacements.push({ path, text: text.replace(site.re, site.repl(sha)) });
    updated.push(site.file);
  }
  for (const replacement of replacements) writeFileSync(replacement.path, replacement.text);
  return updated;
}

const program = new Command();
program
  .name("bump-coflat")
  .description("Rewrite the pinned coflat SHA across the checker, docs, Docker/Compose, and CI")
  .argument("<sha>", "the new coflat commit SHA (40 hex)")
  .action((sha) => {
    let updated;
    try {
      updated = bumpCoflat({ sha });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    for (const file of updated) console.log(`updated ${file}`);
    console.log(`\nNext: push ../coflat at ${sha}, then run \`pnpm refresh:coflat && pnpm dev:fresh\`.`);
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}
