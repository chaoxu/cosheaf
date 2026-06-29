#!/usr/bin/env node
// Publish the packed Workbench tarball as a Gitea release asset on chaoxu/cosheaf
// so a consumer (e.g. earth) can fetch the latest build without saturn being
// online. Builds the bundle first unless --skip-pack.
//
//   node scripts/release-workbench.mjs                 # tag workbench-<YYYYMMDD-HHMM>
//   node scripts/release-workbench.mjs --tag wb-1      # explicit tag
//   node scripts/release-workbench.mjs --skip-pack     # reuse cosheaf-workbench.tar.gz
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = join(repoRoot, "cosheaf-workbench.tar.gz");

const program = new Command();
program
  .name("release-workbench")
  .description("Publish the packed Workbench tarball as a Gitea release asset on chaoxu/cosheaf")
  .option("--tag <tag>", "release tag (default: workbench-<timestamp>)")
  .option("--repo <owner/repo>", "Gitea repo slug", "chaoxu/cosheaf")
  .option("--login <login>", "tea login to use", "coflat")
  .option("--skip-pack", "reuse the existing cosheaf-workbench.tar.gz instead of repacking")
  .parse(process.argv.filter((a, i) => !(i >= 2 && a === "--")));
const opts = program.opts();

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

if (!opts.skipPack) run("node", ["scripts/pack-workbench.mjs"]);
if (!existsSync(tarball)) {
  console.error(`tarball not found: ${tarball} — run without --skip-pack, or pnpm workbench:pack first.`);
  process.exit(1);
}

// Timestamp tag — pass an absolute clock value (scripts run with a real clock;
// only Workflow scripts forbid new Date()). Stable, sortable, no collisions.
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
const tag = opts.tag ?? `workbench-${stamp}`;
const sizeMB = (statSync(tarball).size / 1024 / 1024).toFixed(1);

run("tea", [
  "releases",
  "create",
  "--repo",
  opts.repo,
  "--login",
  opts.login,
  "--tag",
  tag,
  "--title",
  `Cosheaf Workbench ${tag}`,
  "--note",
  `Self-contained Workbench bundle (${sizeMB} MB). Untar and run ./cosheaf-workbench <folder>. Requires Node on the target (same major as built) and matching CPU arch (Apple Silicon).`,
  "--asset",
  tarball,
]);

console.log(`\nPublished ${tag} with cosheaf-workbench.tar.gz (${sizeMB} MB) to ${opts.repo}.`);
