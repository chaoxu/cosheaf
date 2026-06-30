#!/usr/bin/env node

// Rewrite the pinned coflat SHA across every site that carries it: the checker's
// DEFAULT_COFLAT_REF (the single source of truth), setup docs, Docker/Compose,
// and CI. CLAUDE.md is a symlink to AGENTS.md, so it follows.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

// Coflat is unpinned (the sites carry `main` by default). This tool is the
// re-pin escape hatch: rewrite the current ref (a SHA or `main`) across every
// site to an explicit SHA, for a deliberate reproducible build. The match is
// ref-agnostic so it works whether the sites currently hold `main` or a SHA.
const REF = "([0-9a-f]{40}|main)";
const SITES = [
  {
    file: "scripts/check-coflat-ref.mjs",
    re: new RegExp(`(export const DEFAULT_COFLAT_REF = ")${REF}(";)`),
    repl: (sha) => `$1${sha}$3`,
  },
  { file: "README.md", re: new RegExp(`(coflat checkout )${REF}`), repl: (sha) => `$1${sha}` },
  { file: "AGENTS.md", re: new RegExp(`(coflat checkout )${REF}`), repl: (sha) => `$1${sha}` },
  { file: "Dockerfile", re: new RegExp(`(ARG COFLAT_GIT_REF=)${REF}`), repl: (sha) => `$1${sha}` },
  { file: "compose.yaml", re: new RegExp(`(COFLAT_GIT_REF: \\$\\{COFLAT_GIT_REF:-)${REF}(\\})`, "g"), repl: (sha) => `$1${sha}$3` },
  { file: ".github/workflows/ci.yml", re: new RegExp(`(COFLAT_REF: )${REF}`), repl: (sha) => `$1${sha}` },
  { file: ".gitea/workflows/ci.yml", re: new RegExp(`(COFLAT_REF: )${REF}`), repl: (sha) => `$1${sha}` },
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
